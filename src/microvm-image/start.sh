#!/bin/sh
# Container start: launch the Partoo session bootstrap in the background, then run the worker
# as the main process so it keeps handling the /run lifecycle hook.
set -eu

/usr/local/bin/boot.sh &

echo "$(date -Iseconds) start.sh: launching worker"

exec node /opt/worker/worker.mjs
