---
name: project-serve
description: Use to write or fix the project's dev-server file `.claude/claude-peers/serve.json`, which tells Koryphaios how to start the project's dev server. Triggers include "how do I start this project", "configure the dev server for Kory", "write the serve.json", "comment démarrer ce projet", "configure le serveur de dev pour Kory", "écris le serve.json", and a serve.json the Deck rejected. NOT for starting, stopping or testing the server yourself, and NOT for approving it (the operator approves it in a native dialog).
---

# Project serve

You write ONE file, `.claude/claude-peers/serve.json`, that the Deck reads,
validates and shows to the operator for approval before it ever runs. You
propose; the operator approves. Its reader is the Deck's validator first and
the operator second, so it must pass the first and read clearly to the second.

## 1. Find how the project starts

Read, in this order, until the dev command is clear: `package.json` scripts
(`dev`, `start`, `serve`), `vite.config.*` / `next.config.*`, `manage.py` /
`pyproject.toml`, `Gemfile` / `bin/rails`, `Makefile`, `docker-compose.yml`,
then the README. Prefer the project's own script (`npm run dev`) over the
tool it wraps. If several apps live in the repository, ask the operator which
one; a serve.json holds exactly one.

## 2. The contract, field by field

The Deck rejects the WHOLE file on any violation, naming the field.

| field | rule |
|---|---|
| `version` | `1`. |
| `name` | Optional label shown to the operator. |
| `actions` | Exactly ONE action. Two or more are refused. |
| `primary` | Optional; if present, the action's `name`. |
| `actions[0].name` | Short label, e.g. `web`. |
| `actions[0].cwd` | Relative to the project root, inside it (`.` for the root). Never absolute, never `..`, never through a link that leaves the project. |
| `actions[0].command` | One command (section 3). |
| `actions[0].port` | `"auto"` (the Deck picks a free port), or an integer 1024 to 65535 only when the project cannot take another port. |
| `actions[0].url` | Page to open: `http://${HOST}:${PORT}/...`. Host `${HOST}`, `127.0.0.1` or `localhost`, port `${PORT}` (or the fixed port). Anything else is refused. |
| `actions[0].health` | Optional readiness probe, same rule as `url`; defaults to `url`. |
| `actions[0].readyTimeoutSec` | Optional, 1 to 600, default 30. |
| `actions[0].env` | Optional extra variables, UPPER_CASE names. `HOST` and `PORT` are reserved. |
| `actions[0].inheritEnv` | Optional names of the Deck's own variables to pass on. Rarely needed: the server already gets the operator's login environment (PATH included). |

No other field is accepted. `command`, `cwd` and env values refuse control
characters, invisible format characters and any space other than the ASCII
space.

## 3. The command

- The Deck replaces `${HOST}` and `${PORT}` before any shell sees the command.
  These are the only placeholders: do not reference other variables in it.
- The command runs under `/bin/sh` on macOS and Linux and under Windows
  PowerShell 5.1 on Windows. Write ONE command, no chaining: Windows
  PowerShell 5.1 rejects `&&` as a parse error. For several steps, add a
  script to the project (`package.json`) and call that script. Use `cwd`
  instead of `cd`.
- Make the server bind `${HOST}` and listen on `${PORT}`, and fail rather
  than move to another port.
- Keep it short. The dialog shows command, cwd (as an absolute path), port,
  env and inheritEnv in 36-character lines; on a typical screen about 30
  lines are left for your values. Too long, and it cannot be approved at all.

Flags per framework:

| framework | command |
|---|---|
| Vite | `npm run dev -- --host ${HOST} --port ${PORT} --strictPort` |
| Next.js | `npm run dev -- -H ${HOST} -p ${PORT}` |
| Django | `python manage.py runserver ${HOST}:${PORT}` |
| Static files | `python -m http.server ${PORT} --bind ${HOST}` |
| Rails | `ruby bin/rails server -b ${HOST} -p ${PORT}` |

`python` may be `python3` on macOS and Linux: use the name the project's own
docs use. On Windows, `python` may be the Microsoft Store stub that opens the
Store instead of running.
Next.js has no strict-port flag: it may move to another port when `${PORT}` is
taken.

## 4. Examples

Paths, env values and cwd in the examples are placeholders: use the project's own.

<!-- serve-example: valid vite -->
```json
{
  "version": 1,
  "name": "Web app",
  "actions": [
    {
      "name": "web",
      "cwd": ".",
      "command": "npm run dev -- --host ${HOST} --port ${PORT} --strictPort",
      "port": "auto",
      "url": "http://${HOST}:${PORT}/"
    }
  ],
  "primary": "web"
}
```

<!-- serve-example: valid next -->
```json
{
  "version": 1,
  "actions": [
    {
      "name": "site",
      "cwd": "apps/site",
      "command": "npm run dev -- -H ${HOST} -p ${PORT}",
      "port": "auto",
      "url": "http://${HOST}:${PORT}/",
      "readyTimeoutSec": 90
    }
  ]
}
```

<!-- serve-example: valid django -->
```json
{
  "version": 1,
  "actions": [
    {
      "name": "api",
      "cwd": "backend",
      "command": "python manage.py runserver ${HOST}:${PORT}",
      "port": "auto",
      "url": "http://${HOST}:${PORT}/admin/",
      "env": { "DJANGO_SETTINGS_MODULE": "config.settings.dev" }
    }
  ]
}
```

<!-- serve-example: valid http.server -->
```json
{
  "version": 1,
  "actions": [
    {
      "name": "docs",
      "cwd": "site",
      "command": "python -m http.server ${PORT} --bind ${HOST}",
      "port": "auto",
      "url": "http://${HOST}:${PORT}/index.html"
    }
  ]
}
```

<!-- serve-example: valid rails -->
```json
{
  "version": 1,
  "actions": [
    {
      "name": "rails",
      "cwd": ".",
      "command": "ruby bin/rails server -b ${HOST} -p ${PORT}",
      "port": "auto",
      "url": "http://${HOST}:${PORT}/",
      "readyTimeoutSec": 60
    }
  ]
}
```

Refused: two actions in one file.

<!-- serve-example: refused actions -->
```json
{
  "version": 1,
  "actions": [
    { "name": "api", "cwd": "api", "command": "npm run dev", "url": "http://${HOST}:${PORT}/" },
    { "name": "web", "cwd": "web", "command": "npm run dev", "url": "http://${HOST}:${PORT}/" }
  ]
}
```

Refused: a `health` that leaves the machine.

<!-- serve-example: refused health -->
```json
{
  "version": 1,
  "actions": [
    {
      "name": "web",
      "cwd": ".",
      "command": "npm run dev -- --port ${PORT}",
      "url": "http://${HOST}:${PORT}/",
      "health": "http://192.168.1.20:${PORT}/health"
    }
  ]
}
```

## 5. Never

- Never approve on the operator's behalf, and never edit the Deck's approval
  files: approval is the operator's answer in a native dialog.
- Never start the server yourself "to check": the Deck owns the process.
- Never write a command that downloads or installs anything (`npx` of a
  package that is not installed, `pip install`, `curl ... | sh`).
- Never use an absolute `cwd`, a `cwd` outside the project, or a fixed port
  without a reason the operator can read.

## 6. Hand over

Tell the operator, in one or two sentences: which file you wrote, the command,
and that at the first start of the dev server a native dialog will show the
whole file for approval, and again after any change to the command, cwd, env,
inheritEnv or port.
