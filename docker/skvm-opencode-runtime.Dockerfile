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

# CN mirror over HTTP to survive local DNS split-tunnel routing. Same rationale
# as skvm-pi-runtime — see that Dockerfile for the full explanation.
RUN sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g; s|http://security.ubuntu.com|http://mirrors.aliyun.com|g; s|https://mirrors.aliyun.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true

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
