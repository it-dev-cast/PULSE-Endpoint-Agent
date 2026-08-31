package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

// remoteSessionIdleTimeout is how long a session can sit with no activity before it's eligible
// for cleanup - a real support session lasts minutes to an hour and is never reopened once
// both sides leave, so there's no reason to keep it (or its memory) around indefinitely.
const remoteSessionIdleTimeout = 30 * time.Minute

// remoteSession is a real, ephemeral WebRTC signaling relay - deliberately in-memory, not
// persisted to SQLite. Unlike tenants/devices/entitlements, this isn't durable business data:
// once both peers disconnect, there is nothing left worth keeping.
type remoteSession struct {
	id       string
	deviceID string
	tenantID string
	hostname string
	// mode is purely informational for the admin-facing queue (see remoteSessionInfo) - it
	// doesn't change any real signaling/relay behavior, which stays mode-agnostic (a dumb byte
	// relay either way). "screen" is the default for older agent builds that don't send this
	// field at all, since that was this feature's original, only mode.
	mode      string
	createdAt time.Time

	mu           sync.Mutex
	lastActivity time.Time
	peers        map[*websocket.Conn]bool

	// lastMessage/lastMessageType hold the most recent relayed message as an opaque byte blob -
	// found live, not guessed, via a real two-tab test: the Share side sends its offer the
	// instant its own socket opens, which in practice is always before the View side has even
	// created its own socket, so a pure "broadcast to whoever happens to be connected right
	// now" relay silently drops that offer and the View side waits forever. Replaying the last
	// message to a newly-joined peer fixes the race without the relay ever inspecting what the
	// message actually is - it's still a dumb byte-blob store-and-forward, not SDP/ICE-aware
	// protocol logic. Keeping only the single most recent message (not a full history) is
	// correct for this POC's real usage pattern - it only ever sends exactly one offer and one
	// answer, batched (see waitForIceGatheringComplete in ScreenSharePOC.tsx), never a stream
	// of separately-trickled ICE candidates that a single-slot buffer would need to replay all
	// of.
	lastMessage     []byte
	lastMessageType int
}

type remoteSessionStore struct {
	mu       sync.Mutex
	sessions map[string]*remoteSession
}

func newRemoteSessionStore() *remoteSessionStore {
	return &remoteSessionStore{sessions: make(map[string]*remoteSession)}
}

func (s *remoteSessionStore) create(deviceID, tenantID, hostname, mode string) (*remoteSession, error) {
	id, err := newID("rs")
	if err != nil {
		return nil, err
	}
	if mode == "" {
		mode = "screen"
	}
	now := time.Now()
	sess := &remoteSession{
		id:           id,
		deviceID:     deviceID,
		tenantID:     tenantID,
		hostname:     hostname,
		mode:         mode,
		createdAt:    now,
		lastActivity: now,
		peers:        make(map[*websocket.Conn]bool),
	}
	s.mu.Lock()
	s.sessions[id] = sess
	s.mu.Unlock()
	return sess, nil
}

// remoteSessionInfo is the admin-facing view of a real, currently-active session - PeerCount
// doubles as a real, honest status without inventing separate state tracking: 1 means only the
// requesting device has joined (waiting for an operator), 2 means an operator has joined too
// (connected). A session disappears from this list entirely once both sides leave - see
// handleRemoteSessionWS's own cleanup, the same real removal this list reads from live.
type remoteSessionInfo struct {
	ID        string `json:"id"`
	DeviceID  string `json:"deviceId"`
	Hostname  string `json:"hostname"`
	Mode      string `json:"mode"`
	CreatedAt string `json:"createdAt"`
	PeerCount int    `json:"peerCount"`
}

func (s *remoteSessionStore) listByTenant(tenantID string) []remoteSessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []remoteSessionInfo{}
	for _, sess := range s.sessions {
		if sess.tenantID != tenantID {
			continue
		}
		sess.mu.Lock()
		peerCount := len(sess.peers)
		sess.mu.Unlock()
		out = append(out, remoteSessionInfo{
			ID: sess.id, DeviceID: sess.deviceID, Hostname: sess.hostname, Mode: sess.mode,
			CreatedAt: sess.createdAt.UTC().Format(time.RFC3339), PeerCount: peerCount,
		})
	}
	return out
}

func (s *remoteSessionStore) get(id string) (*remoteSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	return sess, ok
}

func (s *remoteSessionStore) remove(id string) {
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

// sweepExpired is the fallback for a session whose peers vanished without a clean WebSocket
// close (e.g. a crashed tab, a lost network) - handleRemoteSessionWS's own defer already
// removes a session the instant it reaches zero peers via a normal close, so this only ever
// catches the abnormal case. A session with any real peer still connected is never swept
// purely on age.
func (s *remoteSessionStore) sweepExpired() {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, sess := range s.sessions {
		sess.mu.Lock()
		expired := now.Sub(sess.lastActivity) > remoteSessionIdleTimeout && len(sess.peers) == 0
		sess.mu.Unlock()
		if expired {
			delete(s.sessions, id)
		}
	}
}

func (s *remoteSessionStore) startCleanupLoop() {
	go func() {
		for {
			time.Sleep(5 * time.Minute)
			s.sweepExpired()
		}
	}()
}

type createRemoteSessionResponse struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt"`
}

// anyDeviceAuthMiddleware is "agent-authenticated," using the same real credential a device
// already holds after registering (its bcrypt-hashed api_key, the exact mechanism
// deviceAuthMiddleware checks for heartbeat/entitlement) - not the separate human-admin JWT
// (POST /v1/auth/login). There is no admin-JWT-acquisition flow anywhere in this project (no
// login UI exists in the frontend), so that JWT isn't a real credential local-agent could
// actually present here; the device's own API key is the only real one it holds. Unlike
// deviceAuthMiddleware, this isn't scoped to one {id} in the URL - starting a support session
// isn't an action "on device X," so it accepts any bearer token matching any currently-
// registered device's real key rather than requiring a specific device ID in the route.
func anyDeviceAuthMiddleware(db *DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			apiKey, ok := bearerToken(r)
			if !ok {
				writeError(w, http.StatusUnauthorized, "missing bearer token")
				return
			}

			// Scanned fully into memory and the cursor closed (via the explicit rows.Close()
			// below, before next.ServeHTTP runs) rather than left open across the downstream
			// call - db.go's own db.SetMaxOpenConns(1) means a single held-open SELECT cursor
			// blocks every other query on the whole process, including any write the downstream
			// handler itself needs to make (e.g. handleCreateRemoteSession's insertEvent),
			// which never runs because it's waiting for the very connection this cursor is
			// still sitting on - a real, confirmed self-deadlock, not a hypothetical one.
			rows, err := db.Query(`SELECT id, tenant_id, hostname, api_key_hash, enrolled_at, last_seen_at, status, fingerprint_locked_at FROM devices`)
			if err != nil {
				log.Printf("remote-sessions auth: failed to query devices: %v", err)
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
			var matched *Device
			for rows.Next() {
				var d Device
				var hash string
				if err := rows.Scan(&d.ID, &d.TenantID, &d.Hostname, &hash, &d.EnrolledAt, &d.LastSeenAt, &d.Status, &d.FingerprintLockedAt); err != nil {
					rows.Close()
					writeError(w, http.StatusInternalServerError, "internal error")
					return
				}
				// secretMatchesHash is a pure bcrypt comparison - no DB access, so checking it
				// here (while rows is still open) isn't what caused the deadlock; only calling
				// next.ServeHTTP before rows.Close() was. Every row still gets checked, not just
				// the first, so a match later in the table is found correctly.
				if matched == nil && secretMatchesHash(apiKey, hash) {
					matched = &d
				}
			}
			rows.Close()

			if matched != nil {
				// Real device identity attached to context - handleCreateRemoteSession needs
				// this to know WHICH device/tenant is starting a session (unlike before, this
				// middleware only proved the key was valid, never exposed whose it was).
				ctx := context.WithValue(r.Context(), deviceContextKey, matched)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			writeError(w, http.StatusUnauthorized, "invalid api key")
		})
	}
}

// handleCreateRemoteSession creates the real signaling session AND, unlike before, logs +
// publishes a real event the instant it's created - this is the actual missing piece that made
// "customer presses Remote Assist" invisible to the dashboard until now. Reuses the exact same
// insertEvent + hub.publishEvent path every other real event already uses, so this shows up
// immediately in the existing Activity Log/Dashboard event stream and toast system with zero new
// frontend plumbing - the same design choice handleCreateIncident already made.
func handleCreateRemoteSession(store *remoteSessionStore, hub *liveHub, db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		// Body is optional and tolerated-empty on purpose - older agent builds (before this
		// mode field existed) send no body at all, and store.create already defaults an empty
		// mode to "screen", this feature's original, only mode.
		var body struct {
			Mode string `json:"mode"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)

		sess, err := store.create(device.ID, device.TenantID, device.Hostname, body.Mode)
		if err != nil {
			log.Printf("remote-sessions: failed to create session: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to create session")
			return
		}
		log.Printf("remote-sessions: created session %s for device %s (mode=%s)", sess.id, device.ID, sess.mode)

		now := time.Now()
		if eventID, err := newID("event"); err == nil {
			kind := "screen share"
			switch sess.mode {
			case "chat":
				kind = "text chat"
			case "voice":
				kind = "voice"
			}
			msg := fmt.Sprintf("Remote assist requested by %s (%s, session %s)", device.Hostname, kind, sess.id)
			event := Event{
				ID: eventID, TenantID: device.TenantID, DeviceID: device.ID,
				EventType: "remote-assist-requested", Message: msg, Severity: "warning",
				CreatedAt: now.UTC().Format(time.RFC3339Nano),
			}
			if err := insertEvent(db, eventID, device.TenantID, device.ID, event.EventType, event.Message, event.Severity, now); err != nil {
				log.Printf("remote-sessions: failed to log remote-assist-requested event: %v", err)
			} else {
				hub.publishEvent(device.TenantID, event)
			}
		}

		writeJSON(w, http.StatusCreated, createRemoteSessionResponse{
			ID:        sess.id,
			CreatedAt: sess.createdAt.UTC().Format(time.RFC3339),
			ExpiresAt: sess.createdAt.Add(remoteSessionIdleTimeout).UTC().Format(time.RFC3339),
		})
	}
}

// handleListTenantRemoteSessions is the admin-facing queue view - the dashboard's initial load
// (before the live event stream's toast already told the operator something happened) and the
// source of truth for whether a session is still waiting or already has an operator connected.
func handleListTenantRemoteSessions(store *remoteSessionStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")
		writeJSON(w, http.StatusOK, store.listByTenant(tenantID))
	}
}

var remoteSessionUpgrader = websocket.Upgrader{
	// Same-origin doesn't mean anything real here - the customer side of a real support
	// session is a bare browser tab with no login, often a completely different
	// origin/device/network than the agent's own dashboard. The session ID itself, shared
	// out-of-band (a link or code given to the customer), is the real access control, the same
	// trust model a real Zoom/Meet guest-join link already uses.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// handleRemoteSessionWS is a dumb relay, on purpose: it never parses or understands the
// SDP/ICE payloads passed through it - the server's job here is transport, not WebRTC protocol
// logic. No auth - the session ID is the access control (see remoteSessionUpgrader's comment).
// Any message from one connected peer is broadcast verbatim to every other peer in the same
// session.
func handleRemoteSessionWS(store *remoteSessionStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		sess, ok := store.get(id)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		conn, err := remoteSessionUpgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("remote-sessions: websocket upgrade failed for session %s: %v", id, err)
			return
		}

		sess.mu.Lock()
		sess.peers[conn] = true
		sess.lastActivity = time.Now()
		peerCount := len(sess.peers)
		var replay []byte
		var replayType int
		if sess.lastMessage != nil {
			replay = sess.lastMessage
			replayType = sess.lastMessageType
		}
		sess.mu.Unlock()
		log.Printf("remote-sessions: peer joined session %s (now %d peer(s))", id, peerCount)
		if replay != nil {
			if err := conn.WriteMessage(replayType, replay); err != nil {
				log.Printf("remote-sessions: replay to newly-joined peer failed in session %s: %v", id, err)
			} else {
				log.Printf("remote-sessions: replayed last message to newly-joined peer in session %s", id)
			}
		}

		defer func() {
			conn.Close()
			sess.mu.Lock()
			delete(sess.peers, conn)
			remaining := len(sess.peers)
			sess.mu.Unlock()
			log.Printf("remote-sessions: peer left session %s (now %d peer(s) left)", id, remaining)
			if remaining == 0 {
				store.remove(id)
				log.Printf("remote-sessions: session %s has no peers left - removed", id)
			}
		}()

		for {
			msgType, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			sess.mu.Lock()
			sess.lastActivity = time.Now()
			sess.lastMessage = data
			sess.lastMessageType = msgType
			for peer := range sess.peers {
				if peer == conn {
					continue
				}
				if err := peer.WriteMessage(msgType, data); err != nil {
					log.Printf("remote-sessions: relay write failed in session %s: %v", id, err)
				}
			}
			sess.mu.Unlock()
		}
	}
}
