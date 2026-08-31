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
//   1. %ProgramData%\Pulse Endpoint\backend\agent-release.json
//   2. agent-release.json in the process working directory
//   3. agent-release.json next to command-center.exe
type agentReleaseFile struct {
	Version   string `json:"version"`
	Installer string `json:"installer"`
}

type agentLatestResponse struct {
	Version     string `json:"version"`
	DownloadURL string `json:"downloadUrl,omitempty"`
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
		out := agentLatestResponse{Version: rel.Version}
		if resolveInstallerPath(rel, jsonDir) != "" {
			out.DownloadURL = publicBackendOrigin(r) + "/v1/agent/download"
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func handleAgentDownload() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
