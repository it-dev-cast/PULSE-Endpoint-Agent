package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
)

// PRD §9.2 "ADE Approval Workflows" - the cryptographically-signed approval mechanism for
// high-impact actions, distinct from the policy-gated-but-immediately-executed Self-Healing
// actions already built (PRD §9's remediation.go-equivalent in telemetry-server.mjs). Ed25519,
// not ECDSA: it's Go's stdlib (crypto/ed25519, no new dependency), has no per-signature nonce/
// RNG pitfall the way ECDSA does (a reused/predictable nonce in ECDSA can leak the private key
// entirely - a real, well-known footgun this sidesteps by construction), fixed-size 32-byte
// keys/64-byte signatures with no curve-parameter choices to get wrong, and is the modern
// default recommendation for new systems that don't have a specific reason to need ECDSA
// (e.g. interop with an existing PKI that only speaks NIST curves - not the case here).

// signingKeyFileName is where the real keypair is persisted - generated once, not regenerated
// every startup, since every previously-issued approval token would become permanently
// unverifiable the instant the key changed. Gitignored, same category as .env.local (a real
// secret, not a placeholder).
const signingKeyFileName = "signing-key.json"

type signingKeyFile struct {
	PublicKey  string `json:"publicKey"`  // base64 of the raw 32-byte Ed25519 public key
	PrivateKey string `json:"privateKey"` // base64 of the raw 64-byte Ed25519 private key
}

// loadOrGenerateSigningKey reads the real persisted keypair if present, or generates and
// persists a new one on first run - the same generate-once-and-persist convention as
// backend/.env.local's ADMIN_PASSWORD/JWT_SECRET (see dotenv.go), just for a keypair instead of
// two random strings.
func loadOrGenerateSigningKey(path string) (ed25519.PublicKey, ed25519.PrivateKey, error) {
	if data, err := os.ReadFile(path); err == nil {
		var stored signingKeyFile
		if err := json.Unmarshal(data, &stored); err != nil {
			return nil, nil, fmt.Errorf("parse signing key file: %w", err)
		}
		pub, err := base64.StdEncoding.DecodeString(stored.PublicKey)
		if err != nil {
			return nil, nil, fmt.Errorf("decode stored public key: %w", err)
		}
		priv, err := base64.StdEncoding.DecodeString(stored.PrivateKey)
		if err != nil {
			return nil, nil, fmt.Errorf("decode stored private key: %w", err)
		}
		return ed25519.PublicKey(pub), ed25519.PrivateKey(priv), nil
	}

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, nil, fmt.Errorf("generate ed25519 key: %w", err)
	}
	stored := signingKeyFile{
		PublicKey:  base64.StdEncoding.EncodeToString(pub),
		PrivateKey: base64.StdEncoding.EncodeToString(priv),
	}
	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return nil, nil, fmt.Errorf("marshal signing key: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return nil, nil, fmt.Errorf("write signing key file: %w", err)
	}
	return pub, priv, nil
}

// approvalTokenPayload builds the exact canonical byte string that gets signed and, on the
// device side, reconstructed and verified - a plain delimited string rather than JSON, so the
// signer (Go) and verifier (Node, on the device) can never disagree over key ordering or
// whitespace when independently rebuilding "what was actually signed."
func approvalTokenPayload(requestID, deviceID, action, expiresAt string) []byte {
	return []byte(requestID + ":" + deviceID + ":" + action + ":" + expiresAt)
}

func signApprovalToken(priv ed25519.PrivateKey, requestID, deviceID, action, expiresAt string) string {
	sig := ed25519.Sign(priv, approvalTokenPayload(requestID, deviceID, action, expiresAt))
	return base64.StdEncoding.EncodeToString(sig)
}
