#!/usr/bin/env bash
#
# Safe timestamped backup of the commandcenter-postgres database.
# Never drops or modifies the source database; only reads via pg_dump.
# Same pattern as /opt/nexusone/scripts/backup-postgres.sh, adapted for this stack's own
# container name/env file.

set -euo pipefail

REPO_DIR="/opt/commandcenter"
ENV_FILE="${REPO_DIR}/.env"
BACKUP_DIR="${REPO_DIR}/backups/postgres"
CONTAINER="commandcenter-postgres"

if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} not found" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

: "${POSTGRES_DB:?POSTGRES_DB not set in .env}"
: "${POSTGRES_USER:?POSTGRES_USER not set in .env}"

if ! docker inspect -f '{{.State.Running}}' "${CONTAINER}" >/dev/null 2>&1; then
  echo "ERROR: container ${CONTAINER} is not running" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUT_FILE="${BACKUP_DIR}/${POSTGRES_DB}_${TIMESTAMP}.sql.gz"
TMP_FILE="${OUT_FILE}.tmp"

echo "Backing up database '${POSTGRES_DB}' from ${CONTAINER} -> ${OUT_FILE}"

if docker exec "${CONTAINER}" pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --format=plain \
    | gzip > "${TMP_FILE}"; then
  mv "${TMP_FILE}" "${OUT_FILE}"
  chmod 600 "${OUT_FILE}"
  echo "Backup complete: ${OUT_FILE} ($(du -h "${OUT_FILE}" | cut -f1))"
else
  echo "ERROR: pg_dump failed, removing incomplete backup" >&2
  rm -f "${TMP_FILE}"
  exit 1
fi
