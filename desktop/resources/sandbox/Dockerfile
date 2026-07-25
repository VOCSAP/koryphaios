# Koryphaios sandbox image (PLAN-SANDBOX M1).
# Build once, then the Deck creates one persistent container per project:
#
#   docker build -t koryphaios-sandbox desktop/resources/sandbox
#
# Contract with sandbox-command.ts — do not change without updating it:
#   - user `kory`, home /home/kory (the kory-claude-auth volume mounts at
#     /home/kory/.claude, so that dir must exist and belong to kory BEFORE
#     the first volume mount copies its ownership)
#   - bash present (launch scripts run `bash -l`), tools reachable from a
#     login shell PATH
#   - bun for the claude-peers MCP server (server.ts), git for worktrees,
#     claude CLI via the native installer (lands in ~/.local/bin)

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git openssh-client procps ripgrep unzip zip \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash kory \
  && mkdir -p /home/kory/.claude /work /kory-run \
  && chown -R kory:kory /home/kory /work /kory-run

USER kory
WORKDIR /work
ENV HOME=/home/kory
ENV PATH="/home/kory/.local/bin:/home/kory/.bun/bin:${PATH}"

# Bun (runs server.ts / project tooling) + Claude Code (native installer).
RUN curl -fsSL https://bun.sh/install | bash \
  && curl -fsSL https://claude.ai/install.sh | bash

# The Deck overrides the command with `sleep infinity` at create; this default
# keeps a hand-run `docker run` usable for debugging.
CMD ["sleep", "infinity"]
