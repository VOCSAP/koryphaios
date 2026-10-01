#!/usr/bin/env python3
"""Run an interactive `claude` in a pty and measure what an AskUserQuestion does.

Modes (exactly one):
  --hooks        which hooks fire, in which order (menu left open ~75 s)
  --redirect     PreToolUse deny naming ask_operator + a fake MCP server
  --type KEYS    type KEYS (python escapes, e.g. '2\\r') into the native menu
  --selftest     pure checks of this script, no CLI, no pty, runs on any OS

Needs Linux/macOS/WSL, python >= 3.8, CLAUDE_CODE_OAUTH_TOKEN in the environment.
Exit: 0 pass, 1 fail, 2 usage/auth, 3 inconclusive (login, trust, no menu).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import select
import shlex
import subprocess
import sys
import tempfile
import time

SECRET_ENV = ("CLAUDE_CODE_OAUTH_TOKEN",)
MCP_SERVER = "claude-peers"
MCP_TOOL = "ask_operator"
TOOL_NAME = "mcp__%s__%s" % (MCP_SERVER, MCP_TOOL)
HOOK_EVENTS = ("PreToolUse", "PermissionRequest", "Notification", "PostToolUse")
REDIRECT_REASON = (
    "Koryphaios Deck policy: on-screen questions (AskUserQuestion) are disabled in "
    "Deck-managed sessions because the operator answers from the Deck inbox or their "
    "phone. Ask the same question with the %s tool (title, question, optional "
    "options); its return value is the operator answer." % TOOL_NAME
)
EXPECTED_ANSWER = {"2\r": ("M5", "Beta"), "Beta\r": ("M6", "Alpha")}
REDACTED = "[REDACTED]"
MIN_FRAGMENT = 12
TOKEN_PREFIX = "sk-ant-"
TOKEN_SHAPE = re.compile(re.escape(TOKEN_PREFIX) + r"[A-Za-z0-9_-]+")
RUN_LIMIT_S = 170
HOOKS_WINDOW_S = 75
TYPE_WINDOW_S = 45
BLOCKERS = (
    (rb"Select login method|Paste code here|Please run /login|Invalid API key|API Error: 401|Invalid bearer token",
     "login screen"),
    (rb"Choose the text style|Let's get started|Welcome to Claude", "onboarding screen"),
    (rb"trust this folder|Do you trust|I trust this", "trust dialog"),
)

HOOKLOG_PY = """import json, os, sys
raw = sys.stdin.read()
try:
    payload = json.loads(raw)
except ValueError:
    payload = {"_raw": raw[:300]}
with open(os.environ["PROBE_LOG"], "a") as f:
    f.write(json.dumps({"tag": sys.argv[1], "payload": payload}) + "\\n")
"""

DENY_PY = """import json, os, sys
raw = sys.stdin.read()
try:
    payload = json.loads(raw)
except ValueError:
    payload = {"_raw": raw[:300]}
with open(os.environ["PROBE_LOG"], "a") as f:
    f.write(json.dumps({"tag": "PreToolUse-deny", "payload": payload}) + "\\n")
sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
    "permissionDecision": "deny", "permissionDecisionReason": %r}}))
""" % REDIRECT_REASON

FAKE_MCP_PY = """import json, os, sys
log = open(os.environ["PROBE_LOG"], "a")
def send(o):
    sys.stdout.write(json.dumps(o) + "\\n")
    sys.stdout.flush()
for line in sys.stdin:
    if not line.strip():
        continue
    m = json.loads(line)
    mid = m.get("id")
    meth = m.get("method")
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": m["params"].get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}}, "serverInfo": {"name": "%s", "version": "0"}}})
    elif meth == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{"name": "%s",
            "description": "Ask the HUMAN operator a blocking question and WAIT for the answer.",
            "inputSchema": {"type": "object", "properties": {"title": {"type": "string"},
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}}},
                "required": ["title", "question"]}}]}})
    elif meth == "tools/call":
        log.write(json.dumps({"tag": "MCP-call", "payload": m["params"]}) + "\\n")
        log.flush()
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "Beta"}]}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
""" % (MCP_SERVER, MCP_TOOL)


def secrets_from_env(env):
    return [env[k] for k in SECRET_ENV if env.get(k)]


def scrub(text, secrets):
    """Redact every secret, every substring of it of MIN_FRAGMENT chars or more, and token-shaped strings."""
    marked = []
    for secret in secrets:
        for start in range(max(len(secret) - MIN_FRAGMENT + 1, 1)):
            needle = secret[start:start + MIN_FRAGMENT]
            at = text.find(needle)
            while needle and at != -1:
                marked.append((at, at + len(needle)))
                at = text.find(needle, at + 1)
    out, cursor = [], 0
    for lo, hi in sorted(marked):
        if hi <= cursor:
            continue
        if lo <= cursor and out:
            cursor = hi
            continue
        out.append(text[cursor:lo])
        out.append(REDACTED)
        cursor = hi
    out.append(text[cursor:])
    return TOKEN_SHAPE.sub(REDACTED, "".join(out))


def _write(path, content):
    with open(path, "w") as f:
        f.write(content)


def _hook_cmd(root, script, tag):
    return "%s %s %s" % (shlex.quote(sys.executable), shlex.quote(os.path.join(root, script)), tag)


def build_workdir(mode, root, log_path):
    """Create the probe files under root; returns (cwd, home, extra_argv). Reads no secret."""
    cwd = os.path.join(root, "proj")
    home = os.path.join(root, "home")
    os.makedirs(os.path.join(cwd, ".claude"), exist_ok=True)
    os.makedirs(home, exist_ok=True)
    open(log_path, "w").close()
    _write(os.path.join(home, ".claude.json"), json.dumps({
        "theme": "dark", "hasCompletedOnboarding": True,
        "projects": {cwd: {"hasTrustDialogAccepted": True}}}))
    _write(os.path.join(root, "hooklog.py"), HOOKLOG_PY)
    pre = _hook_cmd(root, "hooklog.py", "PreToolUse")
    extra = []
    if mode == "redirect":
        _write(os.path.join(root, "deny.py"), DENY_PY)
        _write(os.path.join(root, "fake-mcp.py"), FAKE_MCP_PY)
        pre = _hook_cmd(root, "deny.py", "")
        mcp = os.path.join(root, "mcp.json")
        _write(mcp, json.dumps({"mcpServers": {MCP_SERVER: {
            "command": sys.executable, "args": [os.path.join(root, "fake-mcp.py")],
            "env": {"PROBE_LOG": log_path}}}}))
        extra = ["--mcp-config", mcp, "--strict-mcp-config", "--allowedTools=" + TOOL_NAME]

    def entry(tag, matcher, timeout):
        return [{"matcher": matcher, "hooks": [{
            "type": "command", "command": _hook_cmd(root, "hooklog.py", tag), "timeout": timeout}]}]

    hooks = {
        "PermissionRequest": entry("PermissionRequest", "", 5),
        "Notification": entry("Notification", "", 5),
        "PreToolUse": [{"matcher": "AskUserQuestion",
                        "hooks": [{"type": "command", "command": pre, "timeout": 10}]}],
        "PostToolUse": entry("PostToolUse", "AskUserQuestion", 5),
    }
    _write(os.path.join(cwd, ".claude", "settings.json"), json.dumps({"hooks": hooks}))
    return cwd, home, extra


def prompt_for(mode):
    tail = ("Do nothing else." if mode == "hooks" else
            "When you have my answer, reply with exactly one line ANSWER=<answer> and stop.")
    return ("Use the AskUserQuestion tool to ask me a single question: do I prefer option "
            "Alpha or option Beta? " + tail)


def strip_ansi(b):
    b = re.sub(rb"\x1b\[(\d*)C", lambda m: b" " * int(m.group(1) or 1), b)
    return re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]", b"", b)


def answers_of(payload):
    resp = payload.get("tool_response")
    answers = resp.get("answers") if isinstance(resp, dict) else None
    return [str(v) for v in answers.values()] if isinstance(answers, dict) else []


def evaluate(mode, entries, screen, state, keys=None):
    """Return (verdict, reasons). verdict is PASS, FAIL or INCONCLUSIVE."""
    tags = [e.get("tag") for e in entries]
    if state.get("blocked"):
        return "INCONCLUSIVE", ["blocked by %s" % state["blocked"]]
    if mode in ("hooks", "type") and not state.get("menu_up"):
        return "INCONCLUSIVE", ["the native menu never appeared"]
    why = []
    if mode == "hooks":
        for need in ("PreToolUse", "PermissionRequest", "Notification"):
            if need not in tags:
                why.append("%s did not fire" % need)
        if not why:
            order = [tags.index(t) for t in ("PreToolUse", "PermissionRequest", "Notification")]
            if order != sorted(order):
                why.append("order was %s, expected PreToolUse, PermissionRequest, Notification" % tags)
        kinds = [e["payload"].get("notification_type") for e in entries if e.get("tag") == "Notification"]
        if "agent_needs_input" in kinds:
            why.append("agent_needs_input fired")
        if kinds and "permission_prompt" not in kinds:
            why.append("no permission_prompt notification, got %s" % kinds)
    elif mode == "redirect":
        if "PreToolUse-deny" not in tags:
            why.append("the deny hook never fired")
        calls = [e for e in entries if e.get("tag") == "MCP-call"]
        if not any(c["payload"].get("name") == MCP_TOOL for c in calls):
            why.append("the agent never called %s" % MCP_TOOL)
        if "PermissionRequest" in tags:
            why.append("a PermissionRequest fired despite the deny")
        if not re.search(r"ANSWER=Beta\b", screen):
            why.append("the agent did not reply ANSWER=Beta")
    else:
        post = [e for e in entries if e.get("tag") == "PostToolUse"]
        if not post:
            why.append("no PostToolUse: the typed keys did not answer the question")
        else:
            got = answers_of(post[0]["payload"])
            want = EXPECTED_ANSWER.get(keys or "")
            if want is None:
                return "INCONCLUSIVE", ["no expectation for keys %r, observed answers %s" % (keys, got)]
            if got != [want[1]]:
                why.append("answers were %s, expected [%r]" % (got, want[1]))
    return ("FAIL", why) if why else ("PASS", ["as expected"])


def label_for(mode, keys):
    if mode == "type":
        return EXPECTED_ANSWER.get(keys or "", ("type",))[0]
    return {"hooks": "M1", "redirect": "M3/M4"}[mode]


def exit_code(verdict):
    return {"PASS": 0, "FAIL": 1, "INCONCLUSIVE": 3}[verdict]


def read_entries(log_path):
    out = []
    with open(log_path) as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except ValueError:
                out.append({"tag": "unparsed", "payload": {"_raw": line[:300]}})
    return out


def exit_status(pid):
    """Exit code of an already-closed pty child, or None if it is still running."""
    for _ in range(20):
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except OSError:
            return None
        if done:
            return os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
        time.sleep(0.1)
    return None


def inside_repo(root, repo):
    """True if root, or any ancestor of it, is the repository (symlinks and case aliases resolved)."""
    here = os.path.realpath(root)
    while True:
        try:
            if os.path.samefile(here, repo):
                return True
        except OSError:
            pass
        parent = os.path.dirname(here)
        if parent == here:
            return False
        here = parent


def render_report(version, mode, keys, entries, screen, state, secrets):
    verdict, reasons = evaluate(mode, entries, screen, state, keys)
    lines = ["CLI %s" % version, "MODE %s%s" % (mode, " " + repr(keys) if keys else "")]
    for e in entries:
        payload = dict(e.get("payload", {}))
        for k in ("session_id", "transcript_path", "cwd", "scratchpad_dir", "prompt_id"):
            payload.pop(k, None)
        lines.append("%s %s" % (e.get("tag"), scrub(json.dumps(payload), secrets)[:700]))
    lines.append("SCREEN TAIL: " + scrub(screen, secrets)[-400:])
    lines.append("VERDICT %s %s: %s" % (label_for(mode, keys), verdict, "; ".join(reasons)))
    return scrub("\n".join(lines), secrets) + "\n", verdict


def drive(mode, keys, cwd, home, extra, log_path, env_extra, model):
    import fcntl
    import pty
    import signal
    import struct
    import termios

    env = dict(os.environ)
    env.update({"PROBE_LOG": log_path, "HOME": home, "TERM": "xterm-256color"})
    env.update(env_extra)
    for k in ("CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CONFIG_DIR"):
        env.pop(k, None)
    argv = ["claude", "--permission-mode", "default"] + extra
    if model:
        argv += ["--model", model]
    argv.append(prompt_for(mode))
    pid, fd = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            os.chdir(cwd)
            os.execvpe("claude", argv, env)
        finally:
            os._exit(127)
    state = {"menu_up": False, "blocked": None}
    t0 = time.time()
    buf = b""
    seen = typed = None
    try:
        while time.time() - t0 < RUN_LIMIT_S:
            ready, _, _ = select.select([fd], [], [], 1)
            if ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    if exit_status(pid) == 127:
                        state["blocked"] = "claude could not be executed (exit 127)"
                    break
                buf += data
            s = strip_ansi(buf[-8000:])
            if not state["menu_up"]:
                state["menu_up"] = bool(re.search(rb"Enter\s*to\s*select", s)
                                        and b"Alpha" in s and b"Beta" in s)
                if not state["menu_up"] and time.time() - t0 > 20:
                    for pattern, name in BLOCKERS:
                        if re.search(pattern, s, re.I):
                            state["blocked"] = name
                    if state["blocked"]:
                        break
            tags = [e.get("tag") for e in read_entries(log_path)]
            if mode == "hooks":
                if state["menu_up"] and seen is None:
                    seen = time.time()
                if seen and time.time() - seen > HOOKS_WINDOW_S:
                    break
            elif mode == "type":
                if state["menu_up"] and typed is None:
                    time.sleep(2)
                    os.write(fd, keys.encode("latin-1"))
                    typed = time.time()
                if typed and "PostToolUse" in tags:
                    time.sleep(4)
                    break
                if typed and time.time() - typed > TYPE_WINDOW_S:
                    break
            elif re.search(rb"ANSWER=(Alpha|Beta)\b", s) and time.time() - t0 > 15:
                time.sleep(6)
                break
    finally:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
    screen = re.sub(r"\s+", " ", strip_ansi(buf).decode("utf-8", "replace"))
    return state, screen


def cli_version(env):
    try:
        r = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=30, env=env)
        return (r.stdout or r.stderr).strip()
    except (OSError, subprocess.SubprocessError) as e:
        return "unknown (%s)" % type(e).__name__


def run_probe(args):
    secrets = secrets_from_env(os.environ)
    if not secrets:
        sys.stderr.write("CLAUDE_CODE_OAUTH_TOKEN is not set: pass it through cred exec (and WSLENV under WSL)\n")
        return 2
    mode = "hooks" if args.hooks else "redirect" if args.redirect else "type"
    keys = args.type.encode("utf-8").decode("unicode_escape") if mode == "type" else None
    repo = os.path.realpath(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ctx = None
    try:
        if args.keep_workdir:
            root = os.path.abspath(args.keep_workdir)
        else:
            ctx = tempfile.TemporaryDirectory(prefix="probe-auq-")
            root = ctx.name
        if inside_repo(root, repo):
            sys.stderr.write("refusing a workdir inside the repository: %s\n" % root)
            return 2
        os.makedirs(root, exist_ok=True)
        log_path = os.path.join(root, "hooks.log")
        cwd, home, extra = build_workdir(mode, root, log_path)
        version = cli_version(dict(os.environ, HOME=home))
        state, screen = drive(mode, keys, cwd, home, extra, log_path, {}, args.model)
        report, verdict = render_report(version, mode, keys, read_entries(log_path), screen, state, secrets)
        sys.stdout.write(report)
        return exit_code(verdict)
    finally:
        if ctx is not None:
            ctx.cleanup()


def selftest():
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))

    sentinel = "selftest-SENTINEL-0123456789abcdef"
    tok = "selftest-fake-token-" + "ABCDEFGHIJ0123456789klmnopqrstuvwxyz" * 3

    def leaks(text, secret):
        return any(secret[i:i + MIN_FRAGMENT] in text for i in range(len(secret) - MIN_FRAGMENT + 1))

    check("scrub redacts the secret and its 16-char prefix",
          sentinel not in scrub("a %s b %s c" % (sentinel, sentinel[:16]), [sentinel])
          and sentinel[:16] not in scrub("x %s" % sentinel[:16], [sentinel]))
    check("scrub leaves clean text untouched", scrub("nothing here", [sentinel]) == "nothing here")
    check("secrets_from_env reads the declared variable",
          secrets_from_env({"CLAUDE_CODE_OAUTH_TOKEN": sentinel}) == [sentinel])
    for size in (12, 34, 60):
        check("scrub redacts a %d-char fragment of the secret" % size,
              not leaks(scrub("before %s after" % tok[20:20 + size], [tok]), tok))
    shaped = TOKEN_PREFIX + "x1-" + "Q" * 20
    check("scrub redacts a token-shaped string that is not the env secret",
          "QQQQ" not in scrub("seen %s here" % shaped, []))
    check("scrub keeps a text that shares only 11 characters with the secret",
          scrub("x %s y" % tok[5:16], [tok]) == "x %s y" % tok[5:16])

    raw_entries = [{"tag": "PostToolUse", "payload": {"pad": "x" * 639, "leak": tok}}]
    raw_cut = json.dumps(raw_entries[0]["payload"])[:700]
    raw_screen = tok + "y" * 360
    report, _ = render_report("v", "hooks", None, raw_entries, raw_screen, {"menu_up": True, "blocked": None}, [tok])
    check("test geometry: truncating before scrubbing would leak a payload fragment", leaks(raw_cut, tok))
    check("test geometry: truncating before scrubbing would leak a screen fragment", leaks(raw_screen[-400:], tok))
    check("report never prints a fragment cut by the payload or screen truncation", not leaks(report, tok))

    here = os.path.realpath(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    with tempfile.TemporaryDirectory(prefix="probe-selftest-") as outside:
        check("inside_repo refuses a not yet created path under the repository",
              inside_repo(os.path.join(here, "no-such-dir", "work"), here))
        check("inside_repo accepts a temp dir outside the repository", not inside_repo(outside, here))
        link = os.path.join(outside, "alias")
        try:
            os.symlink(here, link)
        except (OSError, NotImplementedError):
            link = None
        if link:
            check("inside_repo refuses a symlink to the repository", inside_repo(os.path.join(link, "work"), here))
    if hasattr(os, "fork"):
        child = os.fork()
        if child == 0:
            os._exit(127)
        check("exit_status reads the exit code of a closed child", exit_status(child) == 127)

    saved = os.environ.get(SECRET_ENV[0])
    os.environ[SECRET_ENV[0]] = sentinel
    try:
        for mode in ("hooks", "redirect", "type"):
            with tempfile.TemporaryDirectory(prefix="probe-selftest-") as root:
                cwd, home, extra = build_workdir(mode, root, os.path.join(root, "hooks.log"))
                blob = ""
                for base, _, files in os.walk(root):
                    for name in files:
                        with open(os.path.join(base, name)) as f:
                            blob += f.read()
                check("workdir files for %s never contain the secret" % mode, sentinel not in blob)
                check("argv extras for %s never contain the secret" % mode,
                      sentinel not in " ".join(extra))
                settings = json.load(open(os.path.join(cwd, ".claude", "settings.json")))["hooks"]
                check("settings for %s declare exactly the four events" % mode,
                      sorted(settings) == sorted(HOOK_EVENTS))
                check("PreToolUse for %s is scoped to AskUserQuestion" % mode,
                      settings["PreToolUse"][0]["matcher"] == "AskUserQuestion")
                if mode == "redirect":
                    check("redirect reason names the tool the fake server exposes",
                          TOOL_NAME in REDIRECT_REASON and ("--allowedTools=" + TOOL_NAME) in extra)
    finally:
        if saved is None:
            os.environ.pop(SECRET_ENV[0], None)
        else:
            os.environ[SECRET_ENV[0]] = saved

    up = {"menu_up": True, "blocked": None}

    def ent(tag, **payload):
        return {"tag": tag, "payload": payload}

    good_hooks = [ent("PreToolUse"), ent("PermissionRequest"), ent("Notification", notification_type="permission_prompt")]
    check("hooks: expected sequence passes", evaluate("hooks", good_hooks, "", up)[0] == "PASS")
    check("hooks: missing PermissionRequest fails",
          evaluate("hooks", [good_hooks[0], good_hooks[2]], "", up)[0] == "FAIL")
    check("hooks: agent_needs_input fails",
          evaluate("hooks", good_hooks + [ent("Notification", notification_type="agent_needs_input")], "", up)[0] == "FAIL")
    check("hooks: wrong order fails",
          evaluate("hooks", [good_hooks[1], good_hooks[0], good_hooks[2]], "", up)[0] == "FAIL")
    check("hooks: menu never up is inconclusive, not pass",
          evaluate("hooks", [], "", {"menu_up": False, "blocked": None})[0] == "INCONCLUSIVE")
    check("hooks: login screen is inconclusive",
          evaluate("hooks", [], "", {"menu_up": False, "blocked": "login screen"})[0] == "INCONCLUSIVE")

    def post(answer):
        return [ent("PostToolUse", tool_response={"answers": {"q": answer}})]

    check("type 2: Beta passes (M5)", evaluate("type", post("Beta"), "", up, "2\r")[0] == "PASS")
    check("type 2: Alpha fails (M5)", evaluate("type", post("Alpha"), "", up, "2\r")[0] == "FAIL")
    check("type Beta: Alpha passes (M6)", evaluate("type", post("Alpha"), "", up, "Beta\r")[0] == "PASS")
    check("type Beta: Beta fails (M6)", evaluate("type", post("Beta"), "", up, "Beta\r")[0] == "FAIL")
    check("type: no PostToolUse fails", evaluate("type", [], "", up, "2\r")[0] == "FAIL")
    check("type: keys with no expectation are inconclusive, never a pass",
          evaluate("type", post("Beta"), "", up, "9\r")[0] == "INCONCLUSIVE")
    good_redirect = [ent("PreToolUse-deny"), ent("MCP-call", name=MCP_TOOL)]
    check("redirect: deny + call + ANSWER=Beta passes",
          evaluate("redirect", good_redirect, "ANSWER=Beta", up)[0] == "PASS")
    check("redirect: the prompt echo ANSWER=<answer> is not an answer",
          evaluate("redirect", good_redirect, "reply ANSWER=<answer>", up)[0] == "FAIL")
    check("redirect: a PermissionRequest fails",
          evaluate("redirect", good_redirect + [ent("PermissionRequest")], "ANSWER=Beta", up)[0] == "FAIL")
    check("strip_ansi turns cursor-forward into spaces",
          strip_ansi(b"Enter\x1b[1Cto\x1b[1Cselect") == b"Enter to select")
    check("exit codes", [exit_code(v) for v in ("PASS", "FAIL", "INCONCLUSIVE")] == [0, 1, 3])

    failed = 0
    for name, ok, detail in results:
        print("%s %s%s" % ("ok" if ok else "FAIL", name, (": " + detail) if detail and not ok else ""))
        failed += 0 if ok else 1
    print("selftest: %d checks, %d failed" % (len(results), failed))
    return 1 if failed else 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--hooks", action="store_true")
    g.add_argument("--redirect", action="store_true")
    g.add_argument("--type", metavar="KEYS")
    g.add_argument("--selftest", action="store_true")
    p.add_argument("--model")
    p.add_argument("--keep-workdir", metavar="DIR")
    args = p.parse_args(argv)
    try:
        return selftest() if args.selftest else run_probe(args)
    except Exception as e:
        message = "probe crashed: %s: %s\n" % (type(e).__name__, e)
        sys.stderr.write(scrub(message, secrets_from_env(os.environ)))
        return 2


if __name__ == "__main__":
    sys.exit(main())
