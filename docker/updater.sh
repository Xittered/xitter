#!/bin/sh
# Runs in the "updater" compose service. When the app asks for an update
# (data/update-request.json, written while "Update automatically" is on), it
# pulls the checkout the stack was started from and rebuilds the app.
set -u
apk add --no-cache git >/dev/null
git config --global --add safe.directory /repo
project=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$(hostname)")
while :; do
	if [ -f /data/update-request.json ]; then
		echo "update requested: $(cat /data/update-request.json)"
		rm -f /data/update-request.json
		if git -C /repo pull --ff-only; then
			docker compose -p "$project" --project-directory /repo up -d --build app && echo "updated to $(git -C /repo rev-parse --short HEAD)"
		else
			echo "git pull failed; the app stays as it is"
		fi
	fi
	sleep "${UPDATER_EVERY:-60}"
done
