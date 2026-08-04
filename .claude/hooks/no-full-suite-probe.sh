#!/bin/bash
# Probe for no-full-suite.sh. Ships in the repo ON PURPOSE: a probe measured
# once and then left out of the commit is not a guard, because nothing will
# replay it. Run it after any edit to the hook.
#
#   bash .claude/hooks/no-full-suite-probe.sh
#
# It never touches the working checkout: every case runs inside a throwaway
# directory, so the staged-state controls cannot disturb a shared tree.

set -uo pipefail

# HOOK is overridable so the probe itself can be mutation-tested: point it at a
# hook that always allows (the refuse cases must go red) or always blocks (the
# allow cases and the exemption must go red). A probe nobody has seen fail is
# not evidence.
# Resolved BEFORE any cd: the cases below hop through throwaway directories,
# after which a relative $0 no longer resolves.
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$HOOK_DIR/../.." && pwd)"

HOOK="${HOOK:-$HOOK_DIR/no-full-suite.sh}"
[ -f "$HOOK" ] || { echo "hook not found: $HOOK" >&2; exit 1; }

PASS=0
FAIL=0

# Builds the PreToolUse payload with a real JSON encoder, so a case containing
# quotes is not silently mangled into a different command than the one named.
payload() {
  python3 -c '
import sys, json
print(json.dumps({"tool_name": sys.argv[1], "tool_input": {"command": sys.argv[2]}}))
' "$1" "$2"
}

check() {
  local label="$1" want="$2" tool="$3" cmd="$4"
  local got
  payload "$tool" "$cmd" | bash "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want" ]; then
    PASS=$((PASS + 1))
    printf 'ok    %-46s exit=%s  %s\n' "$label" "$got" "$cmd"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-46s want=%s got=%s  %s\n' "$label" "$want" "$got" "$cmd"
  fi
}

# --- Control 1: clean index, inside a repo ---------------------------------
# Nothing staged, so every full-suite spelling must be REFUSED (exit 2).
CLEAN=$(mktemp -d)
cd "$CLEAN" || exit 1
git init -q . 2>/dev/null
git config user.email probe@local 2>/dev/null
git config user.name probe 2>/dev/null

echo "== refuse: full-suite spellings, clean index =="
check "bare"                    2 Bash 'bun test'
check "coverage flag"           2 Bash 'bun test --coverage'
check "name filter"             2 Bash 'bun test -t "some name"'
check "directory arg"           2 Bash 'bun test tests/'
check "directory no slash"      2 Bash 'bun test tests'
check "bun run test"            2 Bash 'bun run test'
check "npm test"                2 Bash 'npm test'
check "npm run test"            2 Bash 'npm run test'
check "compound, second segment" 2 Bash 'cd desktop && bun test'
check "leading whitespace"      2 Bash '   bun test'
check "after a semicolon"       2 Bash 'echo hi; bun test'
check "unknown flag, no path"   2 Bash 'bun test --bail --reporter=junit'

echo
echo "== allow: targeted runs and innocent commands =="
check "one target file"         0 Bash 'bun test tests/desktop-tile-area.test.ts'
check "flags before the path"   0 Bash 'bun test --timeout 10000 tests/x.test.ts'
check "several target files"    0 Bash 'bun test tests/a.test.ts tests/b.test.ts'
check "tsx target"              0 Bash 'bun test tests/c.test.tsx'
check "mention inside an arg"   0 Bash "grep 'bun test' TESTING.md"
check "mention in a pipeline"   0 Bash "cat TESTING.md | grep 'npm test'"
check "no mention at all"       0 Bash 'echo hello'
check "smoke build"             0 Bash 'bun build --target=bun broker.ts --outdir=/tmp/x'
check "typecheck"               0 Bash 'npm run typecheck'
check "not the Bash tool"       0 Read 'bun test'

# --- Control 2 (POSITIVE): something staged -------------------------------
# The exemption must actually fire. Without this case the suite would pass
# just as well if the hook refused unconditionally.
echo
echo "== allow: sequencer exemption, staged content present =="
echo seed > seed.txt
git add seed.txt 2>/dev/null
check "bare, with staged content" 0 Bash 'bun test'
check "npm test, with staged"     0 Bash 'npm test'
git reset -q 2>/dev/null

# --- Control 3 (FAIL-CLOSED): not a repository -----------------------------
# git answers 128 here. Anything other than a clean "staged content exists"
# must refuse, never allow by accident.
echo
echo "== refuse: cwd is not a git repository (fail closed) =="
NOREPO=$(mktemp -d)
cd "$NOREPO" || exit 1
check "bare, outside any repo"  2 Bash 'bun test'

cd / || exit 1
rm -rf "$CLEAN" "$NOREPO"

# --- Control 4: the WIRING, not just the logic -----------------------------
# A hook whose registered path does not resolve cannot refuse anything: it
# exits 127 and the call proceeds. That is a fail-OPEN, and it is invisible
# because everything looks configured. So assert that the command string in
# settings.json names a file that exists, under both resolutions of
# CLAUDE_PROJECT_DIR (it is unset in a plain shell; Claude Code sets it for
# hook execution, hence the ${VAR:-.} fallback).
echo
echo "== wiring: the registered hook path resolves =="
SETTINGS="$PROJECT_ROOT/.claude/settings.json"

wired=$(python3 -c '
import sys, json
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print("ERR " + str(e)); sys.exit(0)
for group in d.get("hooks", {}).get("PreToolUse", []):
    for h in group.get("hooks", []):
        if "no-full-suite" in h.get("command", ""):
            print(group.get("matcher", "") + "\t" + h["command"])
' "$SETTINGS")

if [ -z "$wired" ]; then
  FAIL=$((FAIL + 1))
  echo "FAIL  hook is not registered in .claude/settings.json"
else
  matcher=$(printf '%s' "$wired" | cut -f1)
  cmdstr=$(printf '%s' "$wired" | cut -f2)

  if [ "$matcher" = "Bash" ]; then
    PASS=$((PASS + 1)); echo "ok    matcher is Bash"
  else
    FAIL=$((FAIL + 1)); echo "FAIL  matcher is '$matcher', expected 'Bash'"
  fi

  # Resolve the path argument exactly as a shell would, in both worlds.
  # `eval` is on OUR OWN settings.json, not on external input.
  pathexpr=${cmdstr#bash }
  for ctx in "unset" "set"; do
    if [ "$ctx" = "set" ]; then
      target=$(cd "$PROJECT_ROOT" && CLAUDE_PROJECT_DIR="$PROJECT_ROOT" \
        bash -c "eval printf '%s' $pathexpr" 2>/dev/null)
    else
      target=$(cd "$PROJECT_ROOT" && env -u CLAUDE_PROJECT_DIR \
        bash -c "eval printf '%s' $pathexpr" 2>/dev/null)
    fi
    if [ -f "$PROJECT_ROOT/${target#./}" ] || [ -f "$target" ]; then
      PASS=$((PASS + 1)); printf 'ok    resolves with CLAUDE_PROJECT_DIR %-5s %s\n' "$ctx" "$target"
    else
      FAIL=$((FAIL + 1)); printf 'FAIL  resolves with CLAUDE_PROJECT_DIR %-5s to a missing file: %s\n' "$ctx" "$target"
    fi
  done
fi

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
