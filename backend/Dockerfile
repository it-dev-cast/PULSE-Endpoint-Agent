# syntax=docker/dockerfile:1
#
# Multi-stage build for the Command Center backend, so the deployment server never needs Go
# installed (confirmed directly: it isn't) - the build stage brings its own. modernc.org/sqlite
# (go.mod) is a pure-Go implementation with no CGO, so CGO_ENABLED=0 is a real static build here,
# not just a default left in place.

FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/command-center .

# debian-slim, not distroless/scratch - matches this deployment host's existing convention
# (nexusone-api's own Dockerfile: python:3.12-slim + curl + a non-root appuser), so this
# container can be shelled into and healthchecked the same way every other service on the box
# already is, rather than being the one exception.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out/command-center ./command-center

RUN useradd --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8443

# /v1/health is real and DB-aware (handleHealth in handlers.go) - no auth required, same
# no-secret-needed reasoning main.go's own comment gives for a couple of other public routes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://127.0.0.1:8443/v1/health || exit 1

CMD ["./command-center"]
