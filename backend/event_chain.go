package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Real tamper-evident hash chain over the events table - one chain per tenant, in insertion
// (rowid) order. Standard append-only audit-log pattern: each row's hash covers its own content
// AND the previous row's hash, so changing any field on any row (without also correctly
// recomputing every hash from that point forward) is detectable. This is tamper-EVIDENT, not
// tamper-PROOF - an honest distinction, not hedging: someone with raw, sustained write access to
// the database COULD forge a fully self-consistent alternate chain by recomputing every
// subsequent row's hash too. What this reliably catches is the realistic threat this project
// actually has in mind - a row edited directly (an UPDATE that doesn't know about or bother
// re-deriving the chain), which is exactly what verifyEventChain's own test simulates.
//
// genesisSeed is the fixed, human-readable starting value for prev_hash on a tenant's first-ever
// chained event - readable on purpose (not a hash of some other secret string, not all-zeros) so
// inspecting the raw table makes it immediately obvious which rows are genuine chain starts
// versus rows that simply have no prev_hash recorded (NULL - see ensureEventHashColumns/
// schema.sql's own comment on why pre-feature rows are left NULL rather than backfilled).
const genesisSeed = "genesis"

// computeEventHash is the one real formula both insertEvent (write time) and verifyEventChain
// (read time) use - a single source so they can never quietly drift apart. Fields are joined with
// NUL separators specifically to avoid the classic hash-chain ambiguity ("ab"+"c" vs "a"+"bc"
// hashing identically under naive concatenation) - none of these fields legitimately contain a
// literal NUL byte (event_type/severity are from fixed internal vocabularies, id/created_at are
// generated internally, and message is internally-authored event text, never raw external input).
func computeEventHash(id, tenantID, deviceID, eventType, message, severity, createdAt, prevHash string) string {
	h := sha256.New()
	fields := []string{id, tenantID, deviceID, eventType, message, severity, createdAt, prevHash}
	for _, f := range fields {
		h.Write([]byte(f))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// chainPrevHashForTenant returns the hash chain's current tip for this tenant - the real prev_hash
// the NEXT event should chain from. genesisSeed if this tenant has no chained event yet (either
// truly its first-ever event, or every prior real event has since aged out via
// pruneEventsForDevice - either way, genesisSeed is what a legitimate first-link-in-the-surviving-
// chain looks like, matching verifyEventChain's own tolerance for a chain that doesn't trace all
// the way back to a since-pruned true beginning).
//
// Uses QueryRow specifically, not Query - QueryRow's underlying cursor is released as soon as
// Scan returns (or immediately, on sql.ErrNoRows), so this never holds a cursor open across the
// INSERT that follows it in insertEvent. Holding a cursor open across a subsequent write on this
// project's single-connection (db.SetMaxOpenConns(1)) pool is a real, previously-confirmed
// self-deadlock - see anyDeviceAuthMiddleware's own comment in remote_session.go for where that
// was found live.
func chainPrevHashForTenant(db *DB, tenantID string) (string, error) {
	var hash sql.NullString
	err := db.QueryRow(
		`SELECT hash FROM events WHERE tenant_id = ? AND hash IS NOT NULL ORDER BY seq DESC LIMIT 1`,
		tenantID,
	).Scan(&hash)
	if err == sql.ErrNoRows {
		return genesisSeed, nil
	}
	if err != nil {
		return "", err
	}
	if !hash.Valid {
		// Can't happen given the "hash IS NOT NULL" filter above, but fail closed rather than
		// chain from an empty string if it somehow did.
		return genesisSeed, nil
	}
	return hash.String, nil
}

// ChainVerifyResult is GET /v1/tenants/{id}/events/verify-chain's real response shape - reports
// exactly where a break was found, not just a bare pass/fail, so an operator (or this project's
// own future incident-response process) knows which specific event to investigate.
type ChainVerifyResult struct {
	Intact bool `json:"intact"`
	// ChainedEventsChecked is how many rows actually carry a real hash and were verified -
	// distinct from UntrackedHistoricalEvents below, which predate this feature entirely and are
	// deliberately excluded (see ensureEventHashColumns' own comment on why those aren't
	// backfilled).
	ChainedEventsChecked int `json:"chainedEventsChecked"`
	// UntrackedHistoricalEvents is a real, honest count of rows with no hash at all (NULL,
	// pre-dating this feature) - reported so "chain intact" doesn't get misread as "every event
	// this tenant has ever logged is verified," when only the ones chained since this feature
	// shipped actually are.
	UntrackedHistoricalEvents int `json:"untrackedHistoricalEvents"`
	// StartsAtGenesis is false when the oldest surviving chained event's prev_hash isn't the
	// real genesis value - an honest signal that retention pruning (or something else) has
	// already removed this tenant's true first link, not that anything is wrong. The chain
	// among currently-surviving rows can still be fully verified either way.
	StartsAtGenesis bool `json:"startsAtGenesis"`
	// BrokenAtEventID/Reason are only set when Intact is false.
	BrokenAtEventID *string `json:"brokenAtEventId,omitempty"`
	Reason          *string `json:"reason,omitempty"`
}

// verifyEventChain walks every chained (non-NULL-hash) event for this tenant in real insertion
// order and re-derives each one's hash from its own stored content, catching two distinct kinds
// of tampering:
//  1. Content tampering on any single row - its stored `hash` no longer matches a fresh
//     recomputation from its own (tampered) content + its own stored prev_hash. Checked on every
//     row, unconditionally - this is what a direct `UPDATE events SET message = ...` produces,
//     and needs no assumption about neighboring rows to catch.
//  2. Chain-linkage tampering - a row's prev_hash doesn't match the immediately-preceding
//     SURVIVING row's real hash (e.g. a row deleted and replaced with a forged one that doesn't
//     correctly chain from its real neighbor). Checked from the second row onward only - the
//     very first row in the surviving chain has no prior surviving row to compare against by
//     definition (either it's genuinely the tenant's first event, or its true predecessor was
//     legitimately pruned - both cases are honestly indistinguishable from here, see
//     StartsAtGenesis above), so requiring it to match genesisSeed would produce false positives
//     on perfectly legitimate retention pruning.
func verifyEventChain(db *DB, tenantID string) (ChainVerifyResult, error) {
	var untracked int
	if err := db.QueryRow(`SELECT COUNT(*) FROM events WHERE tenant_id = ? AND hash IS NULL`, tenantID).Scan(&untracked); err != nil {
		return ChainVerifyResult{}, fmt.Errorf("count untracked historical events: %w", err)
	}

	rows, err := db.Query(
		`SELECT id, tenant_id, device_id, event_type, message, severity, created_at, prev_hash, hash
		 FROM events WHERE tenant_id = ? AND hash IS NOT NULL ORDER BY seq ASC`,
		tenantID,
	)
	if err != nil {
		return ChainVerifyResult{}, fmt.Errorf("query chained events: %w", err)
	}
	defer rows.Close()

	result := ChainVerifyResult{Intact: true, UntrackedHistoricalEvents: untracked}
	expectedPrevHash := ""
	first := true

	for rows.Next() {
		var id, tid, did, eventType, message, severity, createdAt, prevHash, hash string
		if err := rows.Scan(&id, &tid, &did, &eventType, &message, &severity, &createdAt, &prevHash, &hash); err != nil {
			return ChainVerifyResult{}, fmt.Errorf("scan chained event: %w", err)
		}
		result.ChainedEventsChecked++

		recomputed := computeEventHash(id, tid, did, eventType, message, severity, createdAt, prevHash)
		if recomputed != hash {
			reason := fmt.Sprintf("event %s: stored hash does not match a fresh recomputation from its own content - this row was modified after being chained", id)
			return ChainVerifyResult{
				Intact: false, ChainedEventsChecked: result.ChainedEventsChecked, UntrackedHistoricalEvents: untracked,
				StartsAtGenesis: first && prevHash == genesisSeed, BrokenAtEventID: &id, Reason: &reason,
			}, rows.Err()
		}

		if first {
			result.StartsAtGenesis = prevHash == genesisSeed
		} else if prevHash != expectedPrevHash {
			reason := fmt.Sprintf("event %s: prev_hash does not match the preceding surviving event's real hash - a row may have been deleted and replaced, reordered, or forged outside the normal insert path", id)
			return ChainVerifyResult{
				Intact: false, ChainedEventsChecked: result.ChainedEventsChecked, UntrackedHistoricalEvents: untracked,
				StartsAtGenesis: result.StartsAtGenesis, BrokenAtEventID: &id, Reason: &reason,
			}, rows.Err()
		}

		expectedPrevHash = hash
		first = false
	}
	if err := rows.Err(); err != nil {
		return ChainVerifyResult{}, err
	}
	return result, nil
}

// handleVerifyEventChain is admin-authenticated (same group as handleListTenantDevices/
// handleListTenantEvents) - the real tamper-detection check itself. A 200 either way (intact or
// not) - a broken chain is a genuine, meaningful result this endpoint exists to report, not a
// server error.
func handleVerifyEventChain(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")

		result, err := verifyEventChain(db, tenantID)
		if err != nil {
			log.Printf("verify-event-chain: failed for tenant %s: %v", tenantID, err)
			writeError(w, http.StatusInternalServerError, "failed to verify event chain")
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}
