# skvm-opencode-runtime — sidecar image that runs the opencode CLI inside a
# Linux container against a bind-mounted workDir. Same motivation as
# skvm-pi-runtime: gives the agent a clean Ubuntu root so model-issued shell
# commands (find /, grep -r, etc.) don't traverse the Windows host filesystem
# via MSYS Git-Bash.
#
# Build:   docker build -t skvm-opencode-runtime:latest -f docker/skvm-opencode-runtime.Dockerfile .
# Verify:  docker run --rm skvm-opencode-runtime:latest opencode --version
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Dual apt source: official archive (always reachable, fallback) + aliyun
# mirror (fast in CN, primary). apt aggregates both stanzas and pulls from
# whichever responds. Hardens against the vpnkit DNS hijack incident where
# aliyun.com got routed to fake IPs (198.18.0.x) and the build failed at
# apt-get update — see skvm-hermes-runtime.Dockerfile for the incident.
# Adding aliyun as a second DEB822 stanza (not a separate .list file)
# avoids apt's "configured multiple times" warning when the same suite
# appears in two sources.
RUN printf '\nTypes: deb\nURIs: http://mirrors.aliyun.com/ubuntu/\nSuites: noble noble-updates noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' >> /etc/apt/sources.list.d/ubuntu.sources

# Base tooling opencode's bash tool commonly needs. Kept minimal — the task's
# own docker image supplies task-specific deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git jq sqlite3 xxd vim-common python3 python3-pip \
    build-essential procps ripgrep unzip \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 from NodeSource. opencode ships as a native Node package.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# npm registry mirror to survive CN network.
RUN npm config set registry https://registry.npmmirror.com

# Install opencode. The skvm opencode adapter passes `--dir <workDir>`,
# `--pure`, `--agent build`, and `--format json` — flags present in the
# publicly released `opencode-ai` npm package since ~1.14+. Not pinned:
# the interaction is purely CLI-level and stable across minor versions.
RUN npm install -g opencode-ai

# Sanity assertion at build time — fails the build if opencode cannot start.
RUN opencode --version && node --version

# The agent's working directory. skvm mounts the host workDir here at run time.
WORKDIR /app

# Default entrypoint is a shell so `docker exec` can call `opencode …` freely.
CMD ["sleep", "36000"]
