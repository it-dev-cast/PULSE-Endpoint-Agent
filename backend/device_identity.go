package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"
)

// Real TPM-backed device identity verification (PRD Section 14.1) - the backend side of
// rust-collector's tpm_identity.rs. A real, non-exportable ECDSA P-256 key created in the
// device's TPM signs the exact hardware-fingerprint JSON telemetry-server.mjs posts; this file
// stores that key (locked once, like hardware_fingerprint/fingerprint_locked_at already are) and
// verifies the signature on every subsequent hardware-check. See tpm_identity.rs's own top
// comment for what this proves and doesn't (real TPM-backed signing, not a formal TCG quote).

const p256CoordLen = 32

// hardwareCheckRequest embeds HardwareFingerprint so the existing field-by-field comparison in
// handleHardwareCheck (fingerprint.go) is completely unchanged - json.Decode promotes the
// embedded struct's own tagged fields to the top level automatically, same request body shape as
// before this feature existed. The signature-related fields are additive and optional: an agent
// build that predates this feature, or a cycle where rust-collector/the TPM was unavailable (see
// telemetry-server.mjs's own signFingerprint comment), simply omits them - decoded as empty
// strings, treated as "not signed this cycle," never a request error.
type hardwareCheckRequest struct {
	HardwareFingerprint
	Signature          string `json:"signature"`
	SignatureAlgorithm string `json:"signatureAlgorithm"`
	// The exact raw JSON string rust-collector hashed and signed - verified against directly,
	// rather than trusting a server-side json.Marshal of the fields above to reproduce the same
	// bytes the agent actually signed (Go's field-declaration order and JS's object-literal order
	// happening to match today is not something a signature check should depend on staying true).
	SignedPayload  string `json:"signedPayload"`
	PublicKey      string `json:"publicKey"`
	KeyAttestation string `json:"keyAttestation"`
}

// parseDeviceIdentityPublicKey decodes the real raw X||Y coordinate pair (64 bytes for P-256)
// tpm_identity.rs sends - not a PEM/DER/SPKI-wrapped key. The agent already strips the
// Windows-specific CNG ECCPUBLICBLOB header before sending (see that file's own comment), so
// there's no reason to wrap this in a second, differently-shaped format just to unwrap it again
// here - Go's crypto/ecdsa only ever needs the two raw coordinates anyway.
func parseDeviceIdentityPublicKey(publicKeyB64 string) (*ecdsa.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(publicKeyB64)
	if err != nil {
		return nil, fmt.Errorf("invalid base64: %w", err)
	}
	if len(raw) != 2*p256CoordLen {
		return nil, fmt.Errorf("unexpected public key length %d (expected %d)", len(raw), 2*p256CoordLen)
	}
	x := new(big.Int).SetBytes(raw[:p256CoordLen])
	y := new(big.Int).SetBytes(raw[p256CoordLen:])
	pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}
	if !pub.Curve.IsOnCurve(pub.X, pub.Y) {
		return nil, fmt.Errorf("public key point is not on the P-256 curve")
	}
	return pub, nil
}

// verifyDeviceSignature checks `signatureB64` (raw r||s, 64 bytes for P-256 - NCryptSignHash's
// own real output shape for ECDSA keys, not ASN.1 DER) against SHA-256(signedPayload) using
// publicKey. This is the one real, load-bearing security check in this file - everything else
// here is bookkeeping around when to call it and what to do with the result.
func verifyDeviceSignature(publicKey *ecdsa.PublicKey, signedPayload, signatureB64 string) (bool, error) {
	sig, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return false, fmt.Errorf("invalid signature base64: %w", err)
	}
	if len(sig) != 2*p256CoordLen {
		return false, fmt.Errorf("unexpected signature length %d (expected %d)", len(sig), 2*p256CoordLen)
	}
	r := new(big.Int).SetBytes(sig[:p256CoordLen])
	s := new(big.Int).SetBytes(sig[p256CoordLen:])
	hash := sha256.Sum256([]byte(signedPayload))
	return ecdsa.Verify(publicKey, hash[:], r, s), nil
}

func getDeviceIdentityPublicKey(db *DB, deviceID string) (*string, error) {
	var pk sql.NullString
	err := db.QueryRow(`SELECT device_identity_public_key FROM devices WHERE id = ?`, deviceID).Scan(&pk)
	if err != nil {
		return nil, err
	}
	if !pk.Valid {
		return nil, nil
	}
	return &pk.String, nil
}

// lockDeviceIdentity stores the device's real public key + key-attestation blob ONLY if none is
// stored yet - the same "first real value wins, never silently overwritten" locking principle
// setDeviceFingerprint/fingerprint_locked_at already establish for the hardware baseline itself.
// Returns whether this call actually did the locking, so the caller can tell a same-cycle
// publicKey resend (locked=false because one was already stored, but it's the identical key)
// apart from a genuinely different, unexpected key showing up.
func lockDeviceIdentity(db *DB, deviceID, publicKeyB64, attestationB64 string) (bool, error) {
	var attestationArg any
	if attestationB64 != "" {
		attestationArg = attestationB64
	}
	res, err := db.Exec(
		`UPDATE devices SET device_identity_public_key = ?, device_identity_attestation = ? WHERE id = ? AND device_identity_public_key IS NULL`,
		publicKeyB64, attestationArg, deviceID,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// verifyDeviceIdentity is a real, additive security check alongside handleHardwareCheck's own
// existing field-by-field hardware comparison - it never blocks or changes that handler's
// response, only fires its own real events, the same "additive signal, not a gate" pattern
// rust-collector/LHM availability already follow elsewhere in this project (a device with no
// working TPM, or a cycle where signing didn't happen, still gets its real tamper comparison).
//
// Three real, distinct outcomes get a critical event, each worded differently since they're
// genuinely different failure modes an operator would investigate differently:
//   - a new publicKey arrives from a device that already has one stored, and it's different -
//     could be a legitimate motherboard replacement (a real new physical TPM) or a cloned/spoofed
//     identity; the stored key is never silently replaced either way.
//   - signedPayload is present but doesn't match this request's own top-level fingerprint fields -
//     the signature can't vouch for data that isn't what was actually signed.
//   - a signature is present and verifiable against the stored key, but doesn't verify - the
//     payload was altered after signing, or the identity itself is no longer genuine.
func verifyDeviceIdentity(db *DB, hub *liveHub, device *Device, req hardwareCheckRequest, now time.Time) {
	if req.PublicKey != "" {
		locked, err := lockDeviceIdentity(db, device.ID, req.PublicKey, req.KeyAttestation)
		if err != nil {
			log.Printf("hardware-check: lockDeviceIdentity failed for %s: %v", device.ID, err)
		} else if !locked {
			if stored, err := getDeviceIdentityPublicKey(db, device.ID); err == nil && stored != nil && *stored != req.PublicKey {
				fireDeviceIdentityEvent(db, hub, device, now, fmt.Sprintf(
					"Device %s (%s) presented a NEW TPM device-identity public key that differs from its stored one. This key is scoped to the Windows user account that created it, not machine-wide (see tpm_identity.rs's own comment on why) - so the most likely benign cause is a different Windows user account creating it for the first time on this same machine (e.g. after a re-image, or a new admin account), which wouldn't find the original account's key locally and would mint a new one. A genuine new physical TPM (motherboard replacement) or a cloned/spoofed identity remain real possibilities too. The stored key was NOT replaced automatically.",
					device.Hostname, device.ID,
				))
			}
		}
	}

	if req.Signature == "" {
		return
	}

	if req.SignedPayload != "" {
		var signedFingerprint HardwareFingerprint
		if err := json.Unmarshal([]byte(req.SignedPayload), &signedFingerprint); err != nil {
			log.Printf("hardware-check: signedPayload for %s is not valid JSON: %v", device.ID, err)
			return
		}
		if fields, _ := compareFingerprints(signedFingerprint, req.HardwareFingerprint); len(fields) > 0 {
			fireDeviceIdentityEvent(db, hub, device, now, fmt.Sprintf(
				"Device %s (%s) posted a hardware-check whose signed payload does not match its own top-level fields (differs in: %s) - the signature cannot vouch for what was actually compared.",
				device.Hostname, device.ID, strings.Join(fields, ", "),
			))
			return
		}
	}

	stored, err := getDeviceIdentityPublicKey(db, device.ID)
	if err != nil {
		log.Printf("hardware-check: getDeviceIdentityPublicKey failed for %s: %v", device.ID, err)
		return
	}
	if stored == nil {
		return // no locked identity yet to verify against
	}
	pub, err := parseDeviceIdentityPublicKey(*stored)
	if err != nil {
		log.Printf("hardware-check: stored public key for %s is corrupt: %v", device.ID, err)
		return
	}
	ok, err := verifyDeviceSignature(pub, req.SignedPayload, req.Signature)
	if err != nil {
		log.Printf("hardware-check: verifyDeviceSignature failed for %s: %v", device.ID, err)
		return
	}
	if !ok {
		fireDeviceIdentityEvent(db, hub, device, now, fmt.Sprintf(
			"Device %s (%s) posted a hardware-check with a signature that does NOT verify against its stored TPM device-identity key. This could mean the payload was tampered in transit, or the device's identity itself is no longer genuine.",
			device.Hostname, device.ID,
		))
	}
}

func fireDeviceIdentityEvent(db *DB, hub *liveHub, device *Device, now time.Time, msg string) {
	eventID, err := newID("event")
	if err != nil {
		log.Printf("hardware-check: failed to generate device-identity-invalid event id: %v", err)
		return
	}
	if err := insertEvent(db, eventID, device.TenantID, device.ID, "device-identity-invalid", msg, "critical", now); err != nil {
		log.Printf("hardware-check: failed to log device-identity-invalid event: %v", err)
		return
	}
	hub.publishEvent(device.TenantID, Event{
		ID: eventID, TenantID: device.TenantID, DeviceID: device.ID,
		EventType: "device-identity-invalid", Message: msg, Severity: "critical",
		CreatedAt: now.UTC().Format(time.RFC3339Nano),
	})
}
