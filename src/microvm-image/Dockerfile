# MicroVM image for the Claude self-hosted sandbox worker, with the Partoo dev-stack tooling.
#
# Base: the VM BASE image (worker runtime, /run lifecycle hook, session outputs volume).
# Added: everything the Partoo Dockerfile provides (docker, compose, buildx, git, make, pnpm,
# mkcert, AWS CLI v2, Playwright + Chromium) plus boot.sh, so the worker can start the dev stack.
#
# The ENTRYPOINT stays the worker: at run time the /run hook delivers the session payload and
# the worker decides when to call /usr/local/bin/boot.sh. boot.sh is NOT run at build time.
# Nothing secret is baked in: GHP_TOKEN, GH_USER and AWS_REGION arrive at launch.
#
# Verify the package names and pinned versions on the first build (arm64 binaries below).
ARG BASE_IMAGE=public.ecr.aws/lambda/microvms:al2023-minimal
FROM ${BASE_IMAGE}

ARG COMPOSE_VERSION=v5.1.2
ARG BUILDX_VERSION=v0.19.3
ARG MKCERT_VERSION=v1.4.4
ARG PLAYWRIGHT_VERSION=1.47.2

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# System packages in one layer. curl-minimal (preinstalled in the base) provides curl; the base's
# microdnf does not support --allowerasing, so curl is not installed explicitly.
# Node 22 replaces the default nodejs of the VM BASE, to match the Partoo dev stack.
RUN dnf install -y --setopt=install_weak_deps=0 \
      bash unzip tar gzip docker git make openssl nss-tools \
      nodejs22 npm \
      nss atk at-spi2-atk cups-libs libxkbcommon libdrm mesa-libgbm alsa-lib pango cairo \
      libXcomposite libXdamage libXrandr libXfixes libXext libX11 libxcb \
 && dnf clean all \
 && ln -sf /usr/bin/node-22 /usr/bin/node \
 && printf '#!/bin/sh\nexec /usr/bin/node-22 /usr/lib/node_modules/npm/bin/npm-cli.js "$@"\n' > /usr/bin/npm \
 && printf '#!/bin/sh\nexec /usr/bin/node-22 /usr/lib/node_modules/npm/bin/npx-cli.js "$@"\n' > /usr/bin/npx \
 && chmod +x /usr/bin/npm /usr/bin/npx \
 && node --version | grep -q '^v22' \
 && npm --version

# pnpm, Playwright and Chromium.
RUN npm install -g --prefix /usr/local pnpm playwright@${PLAYWRIGHT_VERSION} \
 && playwright install chromium \
 && playwright --version

# Docker Compose and buildx (compose needs buildx 0.17 or later), mkcert.
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
      https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-aarch64 \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
 && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-buildx \
      https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-arm64 \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx \
 && curl -fsSL -o /usr/local/bin/mkcert \
      https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-arm64 \
 && chmod +x /usr/local/bin/mkcert

# AWS CLI v2 (official installer), used by boot.sh to read the dev_env secret at session start.
RUN curl -fsSL -o /tmp/awscliv2.zip https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip \
 && unzip -q /tmp/awscliv2.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/aws /tmp/awscliv2.zip

# Session bootstrap script (dockerd, ghcr login, npm credentials, repo clones, devctl install),
# launched by start.sh in the background before the worker starts.
COPY boot.sh /usr/local/bin/boot.sh
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/boot.sh /usr/local/bin/start.sh

# Uploads /mnt/session/outputs to the artifacts bucket and prints presigned links (see upload_outputs.sh).
COPY upload_outputs.sh /usr/local/bin/upload_outputs
RUN chmod +x /usr/local/bin/upload_outputs

WORKDIR /workspace

# Install the worker package (from the VM BASE image).
COPY worker/package.json /opt/worker/package.json
RUN cd /opt/worker && npm install --omit=dev

COPY worker/worker.mjs /opt/worker/worker.mjs

VOLUME /mnt/session/outputs

# start.sh launches boot.sh in the background, then execs the worker (the snapshot entrypoint).
ENTRYPOINT ["/usr/local/bin/start.sh"]
