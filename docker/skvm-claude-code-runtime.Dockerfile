# skvm-claude-code-runtime — sidecar image that runs the Claude Code CLI inside
# a Linux container against a bind-mounted workDir. Same motivation as
# skvm-pi-runtime: gives the agent a clean Ubuntu root so model-issued shell
# commands (find /, grep -r, etc.) don't traverse the Windows host filesystem
# via MSYS Git-Bash.
#
# Build:   docker build -t skvm-claude-code-runtime:latest -f docker/skvm-claude-code-runtime.Dockerfile .
# Verify:  docker run --rm skvm-claude-code-runtime:latest claude --version
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

# Base tooling that claude's bash tool commonly needs. Kept minimal — the
# task's own docker image supplies task-specific deps (compilers, libraries).
# This container is the AGENT's runtime only.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git jq sqlite3 xxd vim-common python3 python3-pip \
    build-essential procps ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 from NodeSource. Claude Code publishes as a native Node package;
# 20 LTS matches its supported runtime range.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# npm registry mirror to survive CN network. npmmirror is Alibaba's mirror.
RUN npm config set registry https://registry.npmmirror.com

# Install the Claude Code CLI. Not version-pinned like pi is, because unlike pi
# the skvm claude-code adapter interacts purely through documented CLI flags
# (`-p`, `--output-format`, `--append-system-prompt`, `--model`, …), not
# through the CLI's internal model registry or config file layout. So minor
# version drift between host and container is safe for bench A/B comparisons.
# Update by rebuilding the image; the tag `latest` locks a stable release.
RUN npm install -g @anthropic-ai/claude-code

# Sanity assertion at build time — fails the build if claude cannot start.
RUN claude --version && node --version

# The agent's working directory. skvm mounts the host workDir here at run time.
WORKDIR /app

# Default entrypoint is a shell so `docker exec` can call `claude …` freely.
CMD ["sleep", "36000"]
