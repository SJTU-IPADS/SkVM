# skvm-hermes-runtime — sidecar image that runs the hermes coding agent
# inside a Linux container against a bind-mounted workDir. Mirrors
# skvm-pi-runtime / skvm-claude-code-runtime / skvm-opencode-runtime:
# solves the "find /" Windows-host-traversal issue by giving hermes a
# clean Ubuntu root to walk.
#
# Unlike the other three (which wrap Node/Bun CLIs), hermes is a Python
# CLI (PyPI: hermes-agent, entry point: `hermes` -> hermes_cli.main).
# Build:   docker build -t skvm-hermes-runtime:latest -f docker/skvm-hermes-runtime.Dockerfile .
# Verify:  docker run --rm skvm-hermes-runtime:latest hermes --version
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# apt uses official archive.ubuntu.com — the CN aliyun mirror was previously
# used to survive DNS split-tunnel, but Docker Desktop's vpnkit routes
# aliyun.com to fake IPs (198.18.0.x) on this machine while the official
# archive is reachable directly. When aliyun becomes reachable again the
# older Dockerfiles can pick up the mirror rewrite; keep this one plain.

# Base tooling hermes's terminal / file tools need. Ubuntu 24.04 already
# ships Python 3.12 (which lands inside hermes-agent's <3.14,>=3.11 range).
# Include build-essential + Rust toolchain kicker for the tiny fraction of
# hermes's transitive deps that ship pure-Python wheels via cffi/cryptography
# — cryptography==46.0.7 has manylinux wheels for x86_64 so no compiler is
# invoked at pip time, but we keep the tooling for defense-in-depth if
# hermes bumps deps that fall back to source.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git jq sqlite3 xxd vim-common ripgrep \
    python3 python3-pip python3-venv \
    build-essential procps \
    && rm -rf /var/lib/apt/lists/*

# pip via CN mirror. tsinghua tuna is the most reliable for large wheel
# downloads (cryptography, pillow) in-region.
RUN pip3 config --global set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    && pip3 config --global set global.break-system-packages true

# Pin hermes-agent to the version currently on PyPI at build time. Unlike
# claude/opencode where the CLI is pure external contract, hermes's
# `sessions export` output IS the parsed contract in src/adapters/hermes.ts
# (HermesSessionExport schema, session_id trailer line, tokens/cost aggregates).
# Version bumps could shift that shape → pin and rebuild the image when
# skvm adapts.
RUN pip3 install hermes-agent==0.18.0

# Sanity assertion at build time — fails the build if hermes cannot start.
RUN hermes --version && python3 --version

# The agent's working directory. skvm mounts the host workDir here at run time.
WORKDIR /app

# Default entrypoint is a shell so `docker exec` can call `hermes …` freely.
CMD ["sleep", "36000"]
