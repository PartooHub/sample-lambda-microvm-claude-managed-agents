#!/bin/bash
# Session start for the Partoo VM. The VM stops when this process exits, so the script never
# exits on a failure: it logs the problem and keeps the VM alive for debugging.
# Needs GHP_TOKEN and GH_USER in the environment (from Secrets Manager at launch).
set -uo pipefail

LOG=/var/log/boot.log
log() { echo "$(date -Iseconds) $*" | tee -a "$LOG"; }

keep_alive() {
  log "keeping the VM alive; it stops when this process exits"
  while true; do sleep 60; done
}

# The worker waits for this file before it terminates the VM. Written when the install ends,
# or straight away when no install runs, so the worker never waits on an install that is not coming.
INSTALL_STATUS=/var/run/install.status
fail_install() {
  echo 1 > "$INSTALL_STATUS"
  keep_alive
}

if [ -z "${GHP_TOKEN:-}" ] || [ -z "${GH_USER:-}" ]; then
  log "GHP_TOKEN and GH_USER must be set at launch"
  fail_install
fi

# The VM mounts no cgroup filesystem; dockerd refuses to start without one (kernel 6.1 supports cgroup v2).
if ! mountpoint -q /sys/fs/cgroup; then
  if mount -t cgroup2 none /sys/fs/cgroup 2>>"$LOG"; then log "cgroup2 mounted"; else log "cgroup2 mount failed; dockerd will not start"; fi
fi

# The Docker daemon runs inside the VM. With systemd as init, start it as a service;
# otherwise (container image, no init) start dockerd directly.
if [ -d /run/systemd/system ]; then
  systemctl start docker
else
  dockerd 2>&1 | tee -a /var/log/dockerd.log &
fi
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
if ! docker info >/dev/null 2>&1; then
  log "dockerd did not start; see /var/log/dockerd.log"
  fail_install
fi
log "dockerd is up"

if echo "$GHP_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin >>"$LOG" 2>&1; then
  log "ghcr login ok"
else
  log "ghcr login failed; the backend build needs it"
fi

# npm reads the @partoohub packages (the web app) from GitHub Packages with the same token.
(umask 077; printf '//npm.pkg.github.com/:_authToken=%s\n@partoohub:registry=https://npm.pkg.github.com/\n' "$GHP_TOKEN" > "$HOME/.npmrc")
log "npm credentials written to ~/.npmrc"

# Clones go over HTTPS; the helper reads the token at clone time, so it is never stored in a git config.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper \
  GIT_CONFIG_VALUE_0='!f() { echo username=x-access-token; echo "password=$GHP_TOKEN"; }; f'
export REPO_URL_BASE=https://github.com/PartooHub

# Clone with HTTP/1.1 (as the Makefile does) and retry: large clones over HTTP/2 abort on this link.
# A partial clone is removed before each retry.
clone_retry() { # <branch> <repo on GitHub> <target folder>
  for i in 1 2 3 4 5; do
    git -c http.version=HTTP/1.1 clone --branch "$1" "$REPO_URL_BASE/$2.git" "$3" && return 0
    rm -rf "$3"; log "clone of $2 failed (attempt $i), retrying"; sleep 5
  done
  return 1
}

# The app reads partoo/development.ini, which git ignores: fetch it from Secrets Manager (stored as gzip + base64).
fetch_config() {
  : "${AWS_REGION:?AWS_REGION must be set at launch}"
  # Clone partoo first so the file has a place; make clone leaves existing checkouts alone.
  [ -d partoo ] || clone_retry feat-compose_dev_env partoo partoo || return 1
  # Write to a temp file first: a failed fetch must not leave a truncated config behind.
  if aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id dev_env \
      --query SecretString --output text | base64 -d | gunzip > partoo/development.ini.tmp; then
    mv partoo/development.ini.tmp partoo/development.ini && chmod 600 partoo/development.ini
  else
    rm -f partoo/development.ini.tmp
    return 1
  fi
}

install_devctl() {
  # devctl sits beside the repos; `make install` clones the ten repos into this same folder.
  mkdir -p /work/Partoo && cd /work/Partoo || return 1
  # The devctl repo is named development-control on GitHub; it is cloned into the partoo-devctl folder.
  [ -d partoo-devctl ] || clone_retry feat-db_init development-control partoo-devctl || return 1
  fetch_config || return 1
  cd partoo-devctl && pnpm install && pnpm run --silent pdev install --branch feat-compose_dev_env --demo --demo-org 1 --json \
    && (cd infra && make front)
}

# The install runs in the background so the VM stays up whatever its result; output goes to a log.
# Its exit code goes to the status file, which the worker waits for before terminating the VM.
# Start the install once the worker is polling for work, so the install does not slow the first
# requests (the key fetch shared the network with the clone). The worker writes WORKER_READY_FILE;
# if it never does, the install starts after the timeout anyway.
WORKER_READY_FILE=/var/run/worker.polling
for _ in $(seq 1 150); do [ -f "$WORKER_READY_FILE" ] && break; sleep 2; done
if [ -f "$WORKER_READY_FILE" ]; then log "worker is polling; starting install"; else log "worker not polling after 300 s; starting install anyway"; fi
( install_devctl; rc=$?; echo "$rc" > "$INSTALL_STATUS"; log "install finished, exit $rc" ) >>/var/log/install.log 2>&1 &
log "install started in background; see /var/log/install.log"

keep_alive
