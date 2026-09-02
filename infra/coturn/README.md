# coturn - Remote Assist TURN relay (PRD §30)

A single self-hosted coturn instance, sized for this project's real deployment scale (a handful
of test devices), not the PRD's enterprise-fleet TURN infrastructure. STUN
(`stun:stun.l.google.com:19302`) stays configured alongside this in the client - TURN is only
used as a fallback when STUN-based peer-to-peer connection fails (restrictive/symmetric NATs).

## Setup

1. Pick a real secret and put it in **two** places (they must match exactly):
   - `backend/.env.local`: `TURN_SECRET=<the secret>`
   - `infra/coturn/.env` (create this file, gitignored, next to `docker-compose.yml`): `TURN_SECRET=<the same secret>`
2. Edit `turnserver.conf`'s `external-ip` - replace `REPLACE_WITH_REAL_HOST_IP` with this host's
   real, externally-reachable address (LAN IP, or a Tailscale address if that's how devices
   reach this machine - see `ScreenSharePOC.tsx`'s own comment on Tailscale addressing). Without
   this, coturn advertises its own container-internal IP, which nothing outside the container can
   reach - TURN relay would silently never work.
3. `backend/.env.local` also needs `TURN_URL=turn:<same external-ip>:3478` - this is what
   `backend/turn.go` hands back to clients as the relay address to actually connect to.
4. `docker compose up -d` from this directory.

## Verifying it's actually working

`docker logs pulse-endpoint-coturn` should show it listening on 3478 with no config errors.
A real end-to-end check: force a session through it by having both peers on networks STUN can't
punch through (or temporarily remove the STUN entry from `ICE_SERVERS` in the client to force
TURN) and confirm the WebRTC connection still completes.

## Why plain UDP, not TURNS (TLS)

The actual media (screen, audio, chat, files) is already SRTP/DTLS-encrypted end-to-end by
WebRTC itself, regardless of whether the TURN relay hop is encrypted. TURNS would additionally
encrypt the signaling-to-relay control channel - a real but lesser concern for an internal
support tool at this project's current scale. Revisit if this ever serves untrusted/public
traffic.
