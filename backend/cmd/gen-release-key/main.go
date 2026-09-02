// gen-release-key generates the real Ed25519 keypair that signs self-update release manifests
// (PRD Section 31). This is a ONE-OFF tool, run manually and rarely (once now, again only if the
// key is ever rotated/lost) - deliberately NOT wired into command-center.exe's own startup the
// way signing.go's approval-token key is, since that key is needed live by an always-running,
// network-facing service while this one is only ever needed by the offline, human-triggered
// publish workflow (sign-release). Confining the private key to that narrower, occasional use is
// the actual security property a separate release key buys over reusing the approval-token key.
//
// Refuses to overwrite an existing key file - regenerating silently would invalidate every
// previously-signed manifest's ability to verify against a NEW embedded public key that hasn't
// been rebuilt into any agent yet, a real, disruptive mistake worth requiring deliberate
// confirmation for for (delete the file yourself first if you genuinely mean to rotate).
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
)

type releaseSigningKeyFile struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

const keyPath = "release-signing-key.json"

func main() {
	if _, err := os.Stat(keyPath); err == nil {
		fmt.Fprintf(os.Stderr, "%s already exists - refusing to overwrite. Delete it yourself first if you really mean to rotate the release key (this will break verification for any agent build whose embedded public key isn't updated to match).\n", keyPath)
		os.Exit(1)
	}

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "generate ed25519 key: %v\n", err)
		os.Exit(1)
	}

	out := releaseSigningKeyFile{
		PublicKey:  base64.StdEncoding.EncodeToString(pub),
		PrivateKey: base64.StdEncoding.EncodeToString(priv),
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal key: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(keyPath, data, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "write %s: %v\n", keyPath, err)
		os.Exit(1)
	}

	fmt.Printf("Wrote %s (mode 0600).\n", keyPath)
	fmt.Println()
	fmt.Println("BACK UP THE PRIVATE KEY NOW, somewhere off this machine (password manager, encrypted drive) -")
	fmt.Println("losing it means every future release needs a new keypair AND a new agent build with a new")
	fmt.Println("embedded public key, breaking update-verification for every already-deployed device.")
	fmt.Println()
	fmt.Println("Public key (embed this in telemetry-server.mjs as RELEASE_PUBLIC_KEY_B64):")
	fmt.Println(out.PublicKey)
}
