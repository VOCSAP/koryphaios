#!/usr/bin/env bash
# Runs inside the container of scripts/ci-replay.ts --docker.
# /replay/tree.tar holds the host working tree: tracked and untracked-not-ignored
# files, so uncommitted work is what gets replayed. The host tree itself is not mounted.
set -euo pipefail
mkdir -p "$HOME" /work/repo
tar -C /work/repo -xf /replay/tree.tar
cd /work/repo
git init -q
# The host working tree is CRLF under core.autocrlf=true, while a Linux runner extracts
# LF: commit it with the CRLF stripped, then check the blobs out again.
git config core.autocrlf input
git add -A
git commit -q -m "ci-replay working tree"
git rm -rq --cached .
git reset -q --hard
n=$(git ls-files --eol | grep -c 'w/crlf' || true)
[ "$n" -eq 0 ] || { echo "[ci-replay] $n files still CRLF" >&2; exit 1; }
# Temp files stay on the container file system: on the bind-mounted /out the broker
# databases and spawned processes of the tests are several times slower and time out.
export CI_REPLAY_TMP=/work/tmp
mkdir -p "$CI_REPLAY_TMP"
set +e
bun scripts/ci-replay.ts --ci-order --split "${1:-6}"
code=$?
cp -r "$CI_REPLAY_TMP/logs" /out/logs || echo "[ci-replay] could not copy the logs to /out/logs: they are lost with the container" >&2
exit $code
