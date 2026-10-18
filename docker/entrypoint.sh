#!/bin/sh
set -e
# the client is downloaded per instance into the client volume, on first start
if [ "$1" = "bun" ] && [ "$2" = "src/server.ts" ] && [ ! -f "${CLIENT_DIR:-client}/build.json" ] && [ "${FETCH_CLIENT:-1}" != "0" ]; then
	echo "No pinned client yet: downloading one (FETCH_CLIENT=0 skips this)."
	bun scripts/fetch-client.ts
fi
exec "$@"
