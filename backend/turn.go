package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"os"
	"strconv"
	"time"
)

// PRD §30 Remote Assist hardening - real TURN relay credentials, using coturn's own documented
// REST API convention ("use-auth-secret"): username is a UNIX expiry timestamp, credential is
// base64(HMAC-SHA1(secret, username)) - the same mechanism Twilio/Jitsi use for exactly this,
// not invented here. TURN_SECRET is the one shared secret coturn.conf's own static-auth-secret
// is configured with (see infra/coturn/README's own comment) - it lives only here and in that
// config file, never on any device.
//
// Deliberately NOT mustEnv'd like JWT_SECRET/ADMIN_PASSWORD - Remote Assist already works
// STUN-only without this (a real, disclosed limitation, see ScreenSharePOC.tsx's own top
// comment), so an unconfigured TURN_SECRET/TURN_URL degrades to "no TURN offered" rather than
// refusing to start the whole service over an optional feature.
//
// Not session-scoped - a TURN credential authorizes relaying ICE traffic in general, the same
// way a STUN server isn't scoped to one call either; scoping to a specific remote-assist session
// would add complexity without a real security benefit at this project's actual scale (a
// time-limited credential a device/operator already had to authenticate to obtain).
const turnCredentialTTL = 6 * time.Hour

func handleIssueTurnCredentials() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		secret := os.Getenv("TURN_SECRET")
		turnURL := os.Getenv("TURN_URL") // e.g. "turn:turn.example.com:3478"
		if secret == "" || turnURL == "" {
			// Real, honest "not configured" - never a fabricated credential. The client falls
			// back to STUN-only, exactly as it already did before TURN existed.
			writeJSON(w, http.StatusOK, map[string]any{"configured": false})
			return
		}

		expiry := time.Now().Add(turnCredentialTTL).Unix()
		username := strconv.FormatInt(expiry, 10)
		mac := hmac.New(sha1.New, []byte(secret))
		mac.Write([]byte(username))
		credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

		writeJSON(w, http.StatusOK, map[string]any{
			"configured": true,
			"urls":       []string{turnURL},
			"username":   username,
			"credential": credential,
			"ttlSeconds": int(turnCredentialTTL.Seconds()),
		})
	}
}
