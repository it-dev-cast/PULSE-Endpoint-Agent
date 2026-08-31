package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// adminSessionDuration is what the PRD would call a "reasonable session length" for a single
// local admin - long enough to not be annoying in a single-operator v1, short enough that a
// leaked token doesn't stay valid indefinitely.
const adminSessionDuration = 12 * time.Hour

func hashSecret(secret string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(secret), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash secret: %w", err)
	}
	return string(hash), nil
}

func secretMatchesHash(secret, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(secret)) == nil
}

func issueAdminToken(jwtSecret string) (string, error) {
	now := time.Now()
	claims := jwt.RegisteredClaims{
		Subject:   "admin",
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(adminSessionDuration)),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(jwtSecret))
	if err != nil {
		return "", fmt.Errorf("sign admin token: %w", err)
	}
	return signed, nil
}

func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return "", false
	}
	token := strings.TrimPrefix(h, prefix)
	if token == "" {
		return "", false
	}
	return token, true
}

// adminAuthMiddleware requires a valid admin JWT from /v1/auth/login - the fleet-view
// endpoints' auth, entirely separate from a device's own API key below.
func adminAuthMiddleware(jwtSecret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tokenStr, ok := bearerToken(r)
			if !ok {
				writeError(w, http.StatusUnauthorized, "missing bearer token")
				return
			}

			_, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
				if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
					return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
				}
				return []byte(jwtSecret), nil
			})
			if err != nil {
				writeError(w, http.StatusUnauthorized, "invalid or expired token")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

type contextKey string

const deviceContextKey contextKey = "device"

// deviceAuthMiddleware requires a bearer token matching the bcrypt hash stored for the specific
// device named in the URL's {id} - a device can only authenticate as itself, not as any other
// device, since the check is against that exact row's api_key_hash.
func deviceAuthMiddleware(db *DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			deviceID := chi.URLParam(r, "id")
			apiKey, ok := bearerToken(r)
			if !ok {
				writeError(w, http.StatusUnauthorized, "missing bearer token")
				return
			}
			
			device, apiKeyHash, err := getDeviceByID(db, deviceID)
			if errors.Is(err, ErrNotFound) {
				writeError(w, http.StatusNotFound, "device not found")
				return
			}
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
			if !secretMatchesHash(apiKey, apiKeyHash) {
				writeError(w, http.StatusUnauthorized, "invalid api key")
				return
			}
			// Real enforcement, not a cosmetic status label - a revoked device's key is
			// genuinely rejected here on every subsequent call, checked only after the key
			// itself is confirmed correct (so a caller without the real key learns nothing
			// about whether this device happens to be revoked).
			if device.Status == "revoked" {
				writeError(w, http.StatusUnauthorized, "device has been revoked")
				return
			}

			ctx := context.WithValue(r.Context(), deviceContextKey, device)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
