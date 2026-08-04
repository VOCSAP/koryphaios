#!/bin/bash
# PreToolUse gate on Bash: refuses the FULL bun test suite unless the caller is
# sequencing commits. Project-scoped (koryphaios), registered in
# .claude/settings.json -- deliberately NOT in the global settings, because the
# cost being avoided is specific to this suite (~113s, 1370+ tests).
#
# Rationale: workers do not commit, so they must run only a targeted test file.
# The full gate is run ONCE by whoever sequences the commits. See TESTING.md,
# "Who runs what", and CLAUDE.md.
#
# Exit 0 = allow, exit 2 = block (stderr is shown to the agent).
#
# SHAPE: allow-list, not deny-list. The rule is "a test invocation must name a
# test FILE", not "these spellings are forbidden". An unrecognised invocation
# therefore fails CLOSED (refused, surfaces the same second) rather than open.
#
# EXEMPTION: staged content in the hook's cwd. That is the only signal the
# caller cannot fake cheaply -- on this shared 8-session checkout, a worker who
# stages in order to unlock the suite has committed a LOUDER violation, visible
# to every other session in `git status`. Identity was not available: no field
# of the PreToolUse payload carries the agent or subagent name (measured
# 2026-08-04 against every hook in ~/.claude/hooks).

set -uo pipefail

INPUT=$(cat)

# --- Fast bail -------------------------------------------------------------
# This hook fires on EVERY Bash call, so the common case must cost nothing.
# If the raw payload does not even mention a candidate spelling, allow without
# spawning a parser. Plain ASCII, so a substring test on the raw JSON is safe.
case "$INPUT" in
  *"bun test"*|*"bun run test"*|*"npm test"*|*"npm run test"*) ;;
  *) exit 0 ;;
esac

# --- Parse -----------------------------------------------------------------
# Only now do we pay for a real JSON parse. Emits two lines: tool_name, command.
PARSED=$(printf '%s' "$INPUT" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    # Unparseable payload: say nothing and let the call through. A broken
    # parser must not become a wall in front of every Bash call in the repo.
    print("")
    print("")
    sys.exit(0)
print(d.get("tool_name", ""))
print((d.get("tool_input") or {}).get("command", "").replace("\n", " "))
' 2>/dev/null)

TOOL_NAME=$(printf '%s' "$PARSED" | sed -n '1p')
COMMAND=$(printf '%s' "$PARSED" | sed -n '2p')

[ "$TOOL_NAME" = "Bash" ] || exit 0
[ -n "$COMMAND" ] || exit 0

# --- Segment ---------------------------------------------------------------
# `cd desktop && bun test` must be caught, so we cannot anchor at the start of
# the whole command. Conversely `grep 'bun test' TESTING.md` must NOT be
# caught. Splitting on shell separators and testing the START of each segment
# satisfies both: a mention inside an argument never begins its segment.
SEGMENTS=$(printf '%s' "$COMMAND" | sed 's/&&/\n/g; s/||/\n/g; s/;/\n/g; s/|/\n/g')

is_test_file() {
  case "$1" in
    *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) return 0 ;;
    *) return 1 ;;
  esac
}

FULL_SUITE_FORM=""

while IFS= read -r seg; do
  # Trim leading whitespace so `  bun test` is still seen as starting with it.
  seg="${seg#"${seg%%[![:space:]]*}"}"

  case "$seg" in
    "bun test"|"bun test "*|"bun run test"|"bun run test "*|\
    "npm test"|"npm test "*|"npm run test"|"npm run test "*) ;;
    *) continue ;;
  esac

  # A recognised test invocation. Allow it ONLY if some argument names an
  # actual test file. A DIRECTORY (`bun test tests/`) contains a slash but is
  # not a file, which is why the check requires an extension and not a slash.
  named_a_file=0
  for tok in $seg; do
    if is_test_file "$tok"; then named_a_file=1; break; fi
  done

  if [ "$named_a_file" -eq 0 ]; then
    FULL_SUITE_FORM="$seg"
    break
  fi
done <<< "$SEGMENTS"

[ -n "$FULL_SUITE_FORM" ] || exit 0

# --- Sequencer exemption ---------------------------------------------------
# `git diff --cached --quiet` exits 1 when staged content EXISTS, 0 when the
# index is clean, and 128 when this is not a repository. Anything that is not a
# clean "1" refuses: git missing, cwd outside a repo, or any unexpected code
# must fail CLOSED, never allow by accident.
if command -v git >/dev/null 2>&1; then
  git diff --cached --quiet >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 1 ]; then
    exit 0
  fi
fi

cat >&2 <<EOF
BLOCKED: that runs the FULL test suite (~113s, 1370+ tests, large output).

  refused: ${FULL_SUITE_FORM}

If you do NOT commit, run only the file you touched:

  bun test tests/<your-file>.test.ts

The full gate (bun test + smoke build + desktop typecheck) is run ONCE, by
whoever sequences the commits, and this hook allows it as soon as anything is
staged. Do NOT stage merely to unlock it: on this shared checkout, staging is
itself a violation and every other session sees it in \`git status\`.

Suspect a cross-file breakage? Report it as an open item instead of running
the full suite to find out. See TESTING.md, "Who runs what".
EOF
exit 2
