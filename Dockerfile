# syntax=docker/dockerfile:1.7
#
# Polyth server container image. See docs/operations/docker.md.
#
#   docker build -t polyth .                          # server + OpenCode + Polyth Link host
#   docker build --target polyth-browser -t polyth:browser .   # + Chromium for the agent browser
#   docker build --build-arg POLYTH_LINK=none -t polyth .      # skip the Rust Link host build
#
# The image runs the same source-tree server as `npm start` (Node type
# stripping), with prebuilt web bundles, the native runtime supervisor and the
# pinned OpenCode binary. It binds loopback by default: run it with host
# networking, or behind a TLS proxy with POLYTH_PUBLIC_ORIGIN (see the docs).

ARG NODE_IMAGE=node:22-bookworm
ARG NODE_RUNTIME_IMAGE=node:22-bookworm-slim
ARG RUST_IMAGE=rust:1.91.0-bookworm
# host = build the Polyth Link host executable, none = omit Polyth Link.
ARG POLYTH_LINK=host

# ---------------------------------------------------------------------------
# Workspace manifests only, so dependency installation stays cached while
# source files change.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
# scripts/check-node.mjs is the root preinstall hook.
RUN find . -type f ! -name package.json ! -name package-lock.json \
      ! -path ./scripts/check-node.mjs -delete \
 && find . -depth -type d -empty -delete

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /opt/polyth
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false
COPY --from=manifests /src/ ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
ARG POLYTH_WEB_BUILD_ID=
RUN POLYTH_WEB_BUILD_ID="${POLYTH_WEB_BUILD_ID}" npm run build \
 && POLYTH_OPENCODE_OUTPUT_DIR=/opt/polyth-bin node apps/desktop/download-opencode.mjs \
 && npm prune --omit=dev \
 && rm -rf apps/desktop/resources apps/desktop/build

# ---------------------------------------------------------------------------
# Polyth Link host (remote/mobile access). Selected by POLYTH_LINK.
FROM ${RUST_IMAGE} AS link-host
WORKDIR /src
# The image already pins the toolchain; rust-toolchain.toml would only add
# rustfmt/clippy downloads that a release build does not need.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --locked --release -p polyth-link-host \
 && install -D -m 0755 target/release/polyth-link-host /out/polyth-link-host

FROM busybox:stable AS link-none
RUN mkdir -p /out

FROM link-${POLYTH_LINK} AS link

# ---------------------------------------------------------------------------
FROM ${NODE_RUNTIME_IMAGE} AS runtime
ARG POLYTH_UID=1000
ARG POLYTH_GID=1000
ARG GH_CLI=1
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash ca-certificates curl git gnupg less openssh-client procps ripgrep tini; \
    if [ "$GH_CLI" = "1" ]; then \
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg; \
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends gh; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    if [ "$POLYTH_GID" != "1000" ]; then groupmod -o -g "$POLYTH_GID" node; fi; \
    if [ "$POLYTH_UID" != "1000" ]; then usermod -o -u "$POLYTH_UID" -g "$POLYTH_GID" node; fi; \
    install -d -o node -g node -m 0750 /data /workspace; \
    chown -R node:node /home/node

COPY --from=build /opt/polyth-bin/opencode /usr/local/bin/opencode
COPY --from=link /out/ /usr/local/lib/polyth-link/
COPY --from=build /opt/polyth /opt/polyth
COPY deploy/docker/entrypoint.sh /usr/local/bin/polyth
RUN chmod 0755 /usr/local/bin/polyth

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=4400 \
    POLYTH_DATA_DIR=/data \
    POLYTH_LINK_HOST=/usr/local/lib/polyth-link/polyth-link-host \
    HOME=/home/node \
    SHELL=/bin/bash
WORKDIR /opt/polyth
USER node
VOLUME ["/data", "/home/node"]
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/polyth"]
CMD ["serve"]

# ---------------------------------------------------------------------------
# Optional variant with Chromium for the agent-drivable browser.
FROM runtime AS polyth-browser
USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji; \
    rm -rf /var/lib/apt/lists/*
ENV POLYTH_CHROMIUM_PATH=/usr/bin/chromium
USER node

# Default target: the server image without Chromium.
FROM runtime AS polyth
