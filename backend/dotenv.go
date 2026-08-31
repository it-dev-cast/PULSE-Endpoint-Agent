package main

import (
	"os"
	"strings"
)

// loadDotEnvIfPresent reads a simple KEY=VALUE .env file (path) and sets each key as a process
// environment variable - but only when that key isn't already set. Real environment variables
// (a CI pipeline, a Docker env block, a Scheduled Task's own environment, or just exporting one
// by hand before running the binary) always win over this file; it exists purely so
// start-command-center.cmd (and `go run .` during local dev) has somewhere to load
// PORT/JWT_SECRET/ADMIN_PASSWORD from without requiring them to be typed into a shell by hand
// every session - the same problem local-agent/server's Scheduled Task already solves for the
// telemetry server, just via a config file here instead of that process needing no secrets at
// all. Missing or unreadable is not an error - mustEnv's own fatal error is what actually
// enforces that the required variables exist, from whichever source actually provided them.
func loadDotEnvIfPresent(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" {
			continue
		}

		if _, alreadySet := os.LookupEnv(key); alreadySet {
			continue
		}
		os.Setenv(key, value)
	}
}
