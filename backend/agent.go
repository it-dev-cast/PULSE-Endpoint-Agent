package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// agent-release.json is how a new Pulse Endpoint agent is published without rebuilding this
// Go service: bump "version" to the frontend package.json version of the build you just
// shipped, point "installer" at the NSIS setup.exe (absolute, or relative to this JSON file
// or to a releases/ folder next to it). Running agents poll GET /v1/agent/latest and show
// "Update available" when that version is newer than the one baked into their own UI.
//
// Looked up in this order so a Scheduled Task whose cwd is %ProgramData%\Pulse Endpoint\backend
// (see start-command-center.cmd) can be updated by editing the file there, without touching
// the source tree:
//  1. %ProgramData%\Pulse Endpoint\backend\agent-release.json
//  2. agent-release.json in the process working directory
//  3. agent-release.json next to command-center.exe
//
// Sha256/Sequence/Ring/Signature are PRD Section 31 Self-Update v1 additions - written by the
// offline sign-release tool at publish time (see cmd/sign-release), never by command-center.exe
// itself. This service only ever passes them through verbatim; it has no reason to verify the
// signature itself (it isn't the one deciding whether to trust and install a release - the agent
// is), and doesn't hold the private key needed to produce one. Tolerant of a release file that
// predates these fields (Sequence/Sha256 zero-valued, Signature/Ring empty) rather than failing
// to parse - the agent's own verification simply refuses to update against an unsigned manifest,
// the same fail-closed posture as everywhere else self-update touches.
type agentReleaseFile struct {
	Version   string `json:"version"`
	Installer string `json:"installer"`
	Sha256    string `json:"sha256"`
	Sequence  int64  `json:"sequence"`
	Ring      string `json:"ring"`
	Signature string `json:"signature"`
}

type agentLatestResponse struct {
	Version     string `json:"version"`
	DownloadURL string `json:"downloadUrl,omitempty"`
	// Installer (the filename, not a URL) is part of what's actually signed - the agent needs it
	// verbatim to reconstruct the exact canonical payload cmd/sign-release signed. See
	// handleAgentLatest's own comment on why the signature covers this, not downloadUrl.
	Installer string `json:"installer,omitempty"`
	Sha256    string `json:"sha256,omitempty"`
	Sequence  int64  `json:"sequence,omitempty"`
	Ring      string `json:"ring,omitempty"`
	Signature string `json:"signature,omitempty"`
}

func agentReleaseSearchPaths() []string {
	var paths []string
	if pd := os.Getenv("ProgramData"); pd != "" {
		paths = append(paths, filepath.Join(pd, "Pulse Endpoint", "backend", "agent-release.json"))
	}
	paths = append(paths, "agent-release.json")
	if exe, err := os.Executable(); err == nil {
		paths = append(paths, filepath.Join(filepath.Dir(exe), "agent-release.json"))
	}
	return paths
}

func loadAgentRelease() (agentReleaseFile, string, bool) {
	var empty agentReleaseFile
	seen := map[string]struct{}{}
	for _, p := range agentReleaseSearchPaths() {
		abs, err := filepath.Abs(p)
		if err != nil {
			continue
		}
		if _, dup := seen[strings.ToLower(abs)]; dup {
			continue
		}
		seen[strings.ToLower(abs)] = struct{}{}
		raw, err := os.ReadFile(abs)
		if err != nil {
			continue
		}
		var rel agentReleaseFile
		if err := json.Unmarshal(raw, &rel); err != nil {
			log.Printf("agent-release: %s is not valid JSON: %v", abs, err)
			continue
		}
		rel.Version = strings.TrimSpace(strings.TrimPrefix(rel.Version, "v"))
		if rel.Version == "" {
			continue
		}
		return rel, filepath.Dir(abs), true
	}
	return empty, "", false
}

func resolveInstallerPath(rel agentReleaseFile, jsonDir string) string {
	name := strings.TrimSpace(rel.Installer)
	if name == "" {
		return ""
	}
	candidates := []string{name}
	if !filepath.IsAbs(name) {
		candidates = []string{
			filepath.Join(jsonDir, name),
			filepath.Join(jsonDir, "releases", name),
			filepath.Join(jsonDir, "releases", filepath.Base(name)),
		}
	}
	root, err := filepath.Abs(jsonDir)
	if err != nil {
		return ""
	}
	rootPrefix := strings.ToLower(root) + string(os.PathSeparator)
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if !filepath.IsAbs(name) {
			lower := strings.ToLower(abs)
			if lower != strings.ToLower(root) && !strings.HasPrefix(lower, rootPrefix) {
				continue
			}
		}
		st, err := os.Stat(abs)
		if err == nil && !st.IsDir() {
			return abs
		}
	}
	return ""
}

func publicBackendOrigin(r *http.Request) string {
	host := strings.TrimSpace(r.Host)
	if host == "" {
		host = "127.0.0.1:8443"
	}
	proto := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		proto = "https"
	}
	return proto + "://" + host
}

func handleAgentLatest() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rel, jsonDir, ok := loadAgentRelease()
		if !ok {
			writeError(w, http.StatusNotFound, "no agent release published")
			return
		}
		out := agentLatestResponse{
			Version:   rel.Version,
			Installer: rel.Installer,
			Sha256:    rel.Sha256,
			Sequence:  rel.Sequence,
			Ring:      rel.Ring,
			// Signature covers "version:sha256:sequence:ring:installer" (see cmd/sign-release) -
			// never the downloadUrl below, which is a per-request-computed convenience field
			// (varies with the request's own Host header, so it could never be part of a stable
			// signed artifact) rather than the thing actually being authenticated. The agent's
			// real trust question is "is this exact file, by hash, genuinely this version" - the
			// URL is just transport.
			Signature: rel.Signature,
		}
		if resolveInstallerPath(rel, jsonDir) != "" {
			out.DownloadURL = publicBackendOrigin(r) + "/v1/agent/download"
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// sanitizeVersionParam guards resolveInstallerPathForVersion below against path traversal via
// ?version= (e.g. "../../../windows/system32/whatever") - only characters a real version string
// could ever contain are allowed through to become part of a filesystem path.
func sanitizeVersionParam(v string) string {
	v = strings.TrimSpace(strings.TrimPrefix(v, "v"))
	for _, r := range v {
		if !(r >= '0' && r <= '9' || r == '.' || r == '-') {
			return ""
		}
	}
	return v
}

// resolveInstallerPathForVersion is the manual-rollback path (PRD Section 31, "keep the
// last-known-good installer accessible") - publish-agent-release.ps1 now retains every past
// version's installer under a version-specific filename in releases/ rather than overwriting the
// same name each publish, so a human can fetch any past release directly, not just the current
// one agent-release.json happens to point at.
func resolveInstallerPathForVersion(version string) string {
	version = sanitizeVersionParam(version)
	if version == "" {
		return ""
	}
	name := "PulseEndpointSetup-" + version + ".exe"
	for _, jsonPath := range agentReleaseSearchPaths() {
		abs, err := filepath.Abs(jsonPath)
		if err != nil {
			continue
		}
		candidate := filepath.Join(filepath.Dir(abs), "releases", name)
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate
		}
	}
	return ""
}

func handleAgentDownload() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if v := r.URL.Query().Get("version"); v != "" {
			path := resolveInstallerPathForVersion(v)
			if path == "" {
				writeError(w, http.StatusNotFound, "that version's installer is not available")
				return
			}
			w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(path)+`"`)
			http.ServeFile(w, r, path)
			return
		}

		rel, jsonDir, ok := loadAgentRelease()
		if !ok {
			writeError(w, http.StatusNotFound, "no agent release published")
			return
		}
		path := resolveInstallerPath(rel, jsonDir)
		if path == "" {
			writeError(w, http.StatusNotFound, "installer file not published")
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(path)+`"`)
		http.ServeFile(w, r, path)
	}
}
