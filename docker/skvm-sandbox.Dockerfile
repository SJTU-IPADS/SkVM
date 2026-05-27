# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    SKVM_IN_SANDBOX=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 python3-pip nodejs npm jq unzip \
    && rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && chmod +x /usr/local/bin/bun

# opencode — not published on npm; installed from GitHub release binary.
# Pinned to v1.4.3 (anomalyco/opencode). Matches skvm install/opencode-version.json.
# SHA-256 verified for linux-x64 asset; bump deliberately and update the hash.
ARG OPENCODE_VERSION=v1.4.3
ARG OPENCODE_SHA256=34d503ebb029853293be6fd4d441bbb2dbb03919bfa4525e88b1ca55d68f3e17
RUN set -e \
    && curl -fsSL \
        "https://github.com/anomalyco/opencode/releases/download/${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
        -o /tmp/opencode.tar.gz \
    && echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/opencode.tar.gz -C /tmp \
    && mv /tmp/opencode /usr/local/bin/opencode \
    && chmod +x /usr/local/bin/opencode \
    && rm /tmp/opencode.tar.gz

# @anthropic-ai/claude-code — published on npm. Pin at known version; bump deliberately.
RUN npm install -g @anthropic-ai/claude-code@2.1.152

# pi / hermes / openclaw: install paths to be filled in when the image is
# first built; TODO follow-ups will add them. For now bare-agent + opencode +
# claude-code is the minimum useful image.

# Baked skvm binary. Build host-side with `bun run build:binary` against the
# matching skvm version, then copy. (The Dockerfile expects dist/skvm to be a
# Linux x86_64 binary — cross-compile on the host before docker build.)
COPY dist/skvm /usr/local/bin/skvm
RUN chmod +x /usr/local/bin/skvm

WORKDIR /workspace

# Do not bake a USER; the launcher passes -u host-uid:host-gid at run time so
# bind-mounted writes are owned by the invoking user.
