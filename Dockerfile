# The openclaw build stage was removed on 2026-09-18.
#
# It cloned and compiled the whole openclaw monorepo (162 workspace projects) into a 3.7GB
# /openclaw directory that this container never executed. The gateway runs the openclaw
# installed on the /data volume instead: `which openclaw` -> /data/npm/bin/openclaw, and
# OPENCLAW_ENTRY is set as a persistent Railway service variable pointing at
# /data/npm/lib/node_modules/openclaw/dist/entry.js. src/server.js only falls back to
# /openclaw/dist/entry.js when that variable is unset, which it is not.
#
# Keeping it had become impossible rather than merely wasteful - it failed three different
# ways in a row: openclaw raising its Node floor past the node:22 base, corepack no longer
# shipping with Node past 24, and finally `pnpm build` being killed with no error output
# after ~64 minutes. Deploys now take about two minutes.
#
# If the volume install ever needs rebuilding, do it against the volume
# (npm install -g openclaw@<version>) and restart the gateway - see the notes on the 9.4
# upgrade - rather than reviving this stage.

# Runtime image
#
# Node 26, not 22, and this is load-bearing: the gateway this container runs is the
# openclaw installed on the /data volume (`which openclaw` -> /data/npm/bin/openclaw,
# OPENCLAW_ENTRY -> /data/npm/lib/node_modules/openclaw/dist/entry.js), currently 2026.9.4,
# which requires Node >=24.16.0 <25 || >=26.1.0. The live container serves it with Node
# 26.8.2, so this file had drifted from the image actually in production - shipping the
# node:22 it used to say would hand the volume's openclaw a Node it refuses to run on.
FROM node:26-bookworm
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

# `openclaw update` expects pnpm. Provide it in the runtime image.
# Installed via npm rather than corepack: Node stopped bundling corepack after 24, so on
# node:26 `corepack enable` dies with "corepack: not found" (exit 127). Same pinned pnpm.
RUN npm install -g pnpm@10.23.0

# Persist user-installed tools by default by targeting the Railway volume.
# - npm global installs -> /data/npm
# - pnpm global installs -> /data/pnpm (binaries) + /data/pnpm-store (store)
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

WORKDIR /app

# Wrapper deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Provide an openclaw executable.
#
# Defers to $OPENCLAW_ENTRY rather than the old hardcoded /openclaw/dist/entry.js, which no
# longer exists now that the build stage is gone. In practice nothing reaches this wrapper:
# PATH puts /data/npm/bin first, so `openclaw` resolves to the volume install. It stays as a
# backstop, and fails loudly with a usable message instead of a confusing "cannot find
# module" if the volume install is ever missing.
RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'entry="${OPENCLAW_ENTRY:-/data/npm/lib/node_modules/openclaw/dist/entry.js}"' \
  'if [ ! -f "$entry" ]; then' \
  '  echo "openclaw: no install found at $entry" >&2' \
  '  echo "openclaw: install it on the volume (npm install -g openclaw@<version>) or set OPENCLAW_ENTRY" >&2' \
  '  exit 127' \
  'fi' \
  'exec node "$entry" "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

COPY src ./src
COPY telemetry ./telemetry
COPY telemetry/triage_dispatch.py ./telemetry/triage_dispatch.py

# The wrapper listens on $PORT.
# IMPORTANT: Do not set a default PORT here.
# Railway injects PORT at runtime and routes traffic to that port.
# If we force a different port, deployments can come up but the domain will route elsewhere.
EXPOSE 8080

# Ensure PID 1 reaps zombies and forwards signals.
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
