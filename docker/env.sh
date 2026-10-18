#!/bin/sh
# Writes .env for compose.yaml with fresh secrets. Refuses to overwrite one:
# the chat and realm secrets must stay the same for the life of the instance.
set -e
cd "$(dirname "$0")/.."
if [ -e .env ]; then echo ".env already exists; not touching it." >&2; exit 1; fi
hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
umask 077
cat > .env <<ENV
# compose.yaml settings; keep the secrets stable and back them up with the volumes
HOST_PORT=3000
PUBLIC_ORIGIN=http://localhost:3000
POSTGRES_PASSWORD=$(hex 24)
REALM_DB_PASSWORD=$(hex 24)
CHAT_TOKEN_SECRET=$(hex 32)
JUICEBOX_REALM_ID=$(hex 16)
JUICEBOX_TENANT_SECRET=$(hex 32)
# optional; any variable from the README's Configuration table can go here
#RESEND_API_KEY=
#MAIL_FROM=Xitter <noreply@example.org>
#KLIPY_API_KEY=
ENV
echo "Wrote .env."
