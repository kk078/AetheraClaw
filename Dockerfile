# syntax=docker/dockerfile:1

# ── The image AetheraClaw runs as on Cloudflare Containers ───────────────────
# Two stages, for one reason: better-sqlite3 is a native module and building it
# needs a C++ toolchain, but SHIPPING it does not. A single-stage image would
# carry python3, make and g++ into production — several hundred megabytes of
# compiler that exists only to be a larger attack surface once the build is done.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for node-gyp. Present in this stage only.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Manifests first, so a source-only change reuses the dependency layer instead
# of reinstalling the tree on every commit.
COPY package.json package-lock.json ./
# `npm ci` rather than `npm install`: it installs exactly the locked versions and
# FAILS when the lockfile and manifest disagree, which is the check that already
# caught a missing tesseract.js entry once. A deploy that silently resolved a
# different version than CI tested is the thing worth refusing.
RUN npm ci

COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
RUN npm run build

# Reinstall without dev dependencies. TypeScript, vitest and tsx have no purpose
# in a running container and are the largest part of node_modules.
RUN npm ci --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# poppler-utils supplies `pdftoppm`. Without it a scanned PDF reaches OCR and is
# refused a second time for a different reason — "no rasteriser is installed" —
# which is honest but is exactly the ordinary case (a faxed EOB) failing.
# ca-certificates is needed to talk to the model providers at all.
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY --from=build /app/scripts ./scripts
COPY package.json ./

# Bind every interface: inside a container 127.0.0.1 is reachable by nothing at
# all, so the loopback default would answer no requests. This is precisely the
# case src/gateway/auth.ts fails closed on — the gateway now REFUSES every
# request unless AETHERACLAW_GATEWAY_TOKEN is set and the edge presents it.
# Binding 0.0.0.0 here is safe only because of that, and only because a
# container port is reachable from its Worker rather than from the internet.
ENV AETHERACLAW_HOST=0.0.0.0 \
    AETHERACLAW_PORT=8080 \
    AETHERACLAW_HOME=/data \
    NODE_ENV=production

# Container disk does not survive a restart. /data is where the working copy of
# the database lives while the instance is up; scripts/container-boot.mjs
# restores it from R2 on start and checkpoints it back.
RUN mkdir -p /data && chmod 700 /data

EXPOSE 8080

# tini as pid 1. Node as pid 1 does not reap zombies, and the OCR path shells
# out to pdftoppm — a batch of scanned EOBs would leave one defunct process per
# page. It also forwards SIGTERM properly, which is what triggers the final
# checkpoint when Cloudflare stops an idle instance.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/container-boot.mjs"]
