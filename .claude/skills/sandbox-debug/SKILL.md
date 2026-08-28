---
name: sandbox-debug
description: Field diagnostics for the Docker sandbox (login loops, config projection, spawn latency, volume state). Use when a sandboxed agent asks to sign in again, the operator's global config seems missing inside a container, a sandbox spawn is slow, or the kory-claude-auth volume / kory-sbx container state must be inspected. Collects the exact probes that solved these classes of bug, without exposing secrets.
---

# Sandbox debugging playbook

Every bug in this area so far was solved by MEASURING the real state (volume,
container, timestamps), never by re-reading the code alone. Run the probes
first; the known root-cause catalogue at the bottom usually matches.

All docker commands from Git Bash: prefix `MSYS_NO_PATHCONV=1`.

## Probe 1 -- what is actually in the auth volume

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v kory-claude-auth:/vol alpine:latest sh -c \
  'ls -la /vol; echo ---; find /vol -maxdepth 1 -type l -exec ls -la {} \;'
```

Read it like this:
- `.credentials.json` present + recent = OAuth completed at that time.
- `.claude.json` present = the CLI ran with `CLAUDE_CONFIG_DIR` set (the fix);
  absent = some path still runs the CLI without it.
- Any symlink pointing at a `C:\...` target = debris from a pre-`docker cp -L`
  copy; the projection purge should have removed it (if it persists, the purge
  regressed).
- A FILE literally named `C:\Users\...` = something wrote through a dangling
  Windows-target symlink (the target string is a valid relative Linux name).

## Probe 2 -- login state WITHOUT exposing secrets

Never cat `.claude.json` / `.credentials.json` (the permission classifier
blocks it, and rightly so). Presence of KEYS is enough:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v kory-claude-auth:/vol alpine:latest sh -c \
  'for k in oauthAccount hasCompletedOnboarding userID; do printf "%s: %s\n" "$k" "$(grep -c "$k" /vol/.claude.json)"; done'
```

- `oauthAccount 1` + `hasCompletedOnboarding 0` = the login PTY was killed
  mid-onboarding (or onboarding never finished): every agent will re-show the
  onboarding screen even though credentials are valid. Remedy: Re-authenticate
  and complete the CLI onboarding to its final screen.
- The real auth probe the app runs (exit 0 = agents will NOT ask to sign in):
  see `buildAuthProbeArgs` in `sandbox-command.ts` -- it requires BOTH files.

## Probe 3 -- container env and mounts

```bash
docker inspect <kory-sbx-...> --format '{{json .Config.Env}}'
docker inspect <kory-sbx-...> --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

`CLAUDE_CONFIG_DIR=/home/kory/.claude` must be present, and the volume mounted
on `/home/kory/.claude`. Works on an Exited container too.

## Probe 4 -- projection freshness (why is old config inside?)

Compare mtimes; docker cp PRESERVES source mtimes, so a projected file dated
"old" may still be a FRESH copy of an old source -- compare against the
projection marker instead:

```bash
ls --full-time ~/.claude/sandbox-overrides/settings.json \
  "$APPDATA/koryphaios/config/sandbox-projected-<container>"
```

Marker OLDER than the overlay/config change = the projection has not rerun
since; the next `ensure()` (agent spawn or warm-up) picks it up because the
signature includes the overlay's size+mtime. Marker file content is
`<containerId>\n<signature>` -- a recreate mints a new id, no manual
invalidation exists or is needed.

## Probe 5 -- spawn latency

- Journal line `sandbox: ensure took NNNms (image=.. inspect=.. projection=..)`
  is emitted whenever the pre-flight exceeds 1.5 s -- read it before guessing.
- Measured baselines (this class of machine, Docker Desktop/WSL2): CLI
  invocation ~150 ms, `exec` ~156 ms, `run --rm` ~480 ms, `docker cp` of
  `plugins/` (192 MiB) ~9.7 s. A slow spawn is almost always a projection
  (first spawn on a NEW container id, or a config change), not the docker
  round-trips.
- Warm-up should have prepaid it: app start (sandbox enabled) and image-build
  completion both fire `warmUp()`.

## Known root causes (all CONFIRMED, in fix order)

1. `.claude.json` lived in `$HOME`, outside the shared volume -> fixed by
   `CLAUDE_CONFIG_DIR` (Dockerfile ENV + sandboxifyEnv + auth mounts).
2. `docker cp -L` does not replace a destination DIRECTORY SYMLINK -> purge
   before copy (`buildProjectionCleanArgs`).
3. Login PTY killed on credentials-file appearance, before
   `hasCompletedOnboarding` was written -> probe requires both.
4. `docker cp` lands files as ROOT regardless of the image USER -> purge and
   chown run `--user root` (`buildProjectionChownArgs`), otherwise the CLI
   cannot maintain its own copy and a kory `rm` sprays Permission denied.
5. In-memory "already projected" marker made every app start re-pay the ~10 s
   projection -> marker persisted, keyed by container ID + config signature.

Detailed narrative: `desktop/docs/sandbox.md`, commits `32d2249` (M1) and
`959c98f` (M2/M3) -- or `git log --all --grep "Sandbox mode"` -- Kleos
memories #11664 #11665 #11668-#11670 #11673 #11674.
