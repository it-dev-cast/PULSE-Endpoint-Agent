package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// newID generates a random, non-guessable identifier prefixed for readability in logs/DB
// browsing (e.g. "device_3f9a1c...") - not a sequential/incrementing ID, so device/entitlement
// IDs never leak how many rows exist.
func newID(prefix string) (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate id: %w", err)
	}
	return fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(buf)), nil
}

// generateAPIKey produces the plaintext device API key returned exactly once from
// /v1/devices/register. Only its bcrypt hash (see hashSecret) is ever persisted.
func generateAPIKey() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate api key: %w", err)
	}
	return "cec_" + hex.EncodeToString(buf), nil
}
