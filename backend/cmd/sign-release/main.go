// sign-release is the offline, human-triggered publish-time signer for PRD Section 31 Self-Update
// v1 manifests - invoked by installer/publish-agent-release.ps1, never by command-center.exe's
// own runtime. Reads release-signing-key.json (gitignored, generated once by ./cmd/gen-release-key
// - see that tool's own comment for why this key is deliberately never loaded by the live
// service), computes the real SHA-256 of the installer file being published, reads the current
// agent-release.json (if any) to find the last sequence number so this publish's is strictly
// greater (the real anti-replay mechanism - see telemetry-server.mjs's own comment on the agent
// side of this), signs the canonical payload, and writes the new agent-release.json.
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

type releaseSigningKeyFile struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

// Matches backend/agent.go's agentReleaseFile exactly - this tool writes what that handler reads.
type agentReleaseFile struct {
	Version   string `json:"version"`
	Installer string `json:"installer"`
	Sha256    string `json:"sha256"`
	Sequence  int64  `json:"sequence"`
	Ring      string `json:"ring"`
	Signature string `json:"signature"`
}

// releasePayload must match telemetry-server.mjs's own reconstruction of what it verifies -
// deliberately a plain delimited string, not JSON, for the same reason backend/signing.go's
// approvalTokenPayload is: the signer (Go) and verifier (Node) can never disagree over JSON key
// ordering/whitespace when independently rebuilding "what was actually signed."
func releasePayload(version, sha256Hex string, sequence int64, ring, installer string) []byte {
	return []byte(version + ":" + sha256Hex + ":" + strconv.FormatInt(sequence, 10) + ":" + ring + ":" + installer)
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func main() {
	version := flag.String("version", "", "release version, e.g. 0.2.0")
	installerPath := flag.String("installer", "", "path to the installer file being published")
	installerName := flag.String("installer-name", "", "filename to record in the manifest (defaults to the installer's own basename)")
	keyPath := flag.String("key", "release-signing-key.json", "path to the release signing keypair")
	outPath := flag.String("out", "agent-release.json", "path to write the signed manifest to")
	ring := flag.String("ring", "stable", "forward-compatible ring tag - not real rollout infrastructure yet, see PRD Section 31 investigation")
	flag.Parse()

	if *version == "" || *installerPath == "" {
		fmt.Fprintln(os.Stderr, "usage: sign-release -version 0.2.0 -installer path\\to\\Setup.exe [-installer-name PulseEndpointSetup-0.2.0.exe] [-key release-signing-key.json] [-out agent-release.json] [-ring stable]")
		os.Exit(1)
	}
	name := strings.TrimSpace(*installerName)
	if name == "" {
		name = *installerPath
		if idx := strings.LastIndexAny(name, `/\`); idx >= 0 {
			name = name[idx+1:]
		}
	}

	keyData, err := os.ReadFile(*keyPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read %s: %v (run ./cmd/gen-release-key once if this is a fresh checkout)\n", *keyPath, err)
		os.Exit(1)
	}
	var key releaseSigningKeyFile
	if err := json.Unmarshal(keyData, &key); err != nil {
		fmt.Fprintf(os.Stderr, "parse %s: %v\n", *keyPath, err)
		os.Exit(1)
	}
	priv, err := base64.StdEncoding.DecodeString(key.PrivateKey)
	if err != nil {
		fmt.Fprintf(os.Stderr, "decode private key: %v\n", err)
		os.Exit(1)
	}

	sha, err := sha256File(*installerPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "hash %s: %v\n", *installerPath, err)
		os.Exit(1)
	}

	// Real anti-replay - strictly greater than whatever this exact manifest file last recorded,
	// not just "increment by one" (a fresh/missing agent-release.json starts at 1, never 0, so a
	// tampered-to-absent file can't be used to reset the counter back to something an agent
	// might treat as unseen).
	var sequence int64 = 1
	if existing, err := os.ReadFile(*outPath); err == nil {
		var prev agentReleaseFile
		if json.Unmarshal(existing, &prev) == nil && prev.Sequence > 0 {
			sequence = prev.Sequence + 1
		}
	}

	sig := ed25519.Sign(ed25519.PrivateKey(priv), releasePayload(*version, sha, sequence, *ring, name))

	out := agentReleaseFile{
		Version:   strings.TrimPrefix(strings.TrimSpace(*version), "v"),
		Installer: name,
		Sha256:    sha,
		Sequence:  sequence,
		Ring:      *ring,
		Signature: base64.StdEncoding.EncodeToString(sig),
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal manifest: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*outPath, data, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write %s: %v\n", *outPath, err)
		os.Exit(1)
	}

	fmt.Printf("Signed release v%s (sequence %d) -> %s\n", out.Version, out.Sequence, *outPath)
}
