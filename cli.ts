#!/usr/bin/env bun
/**
 * Talks to loopback by default; a configured broker_url/broker_token
 * (shared/config.ts) redirects every command to that remote broker directly
 * instead.
 * 'send' is intentionally absent -- the broker requires a valid instance_token
 * for routing, which only a registered MCP peer holds.
 */

import { loadConfig, brokerUrl } from "./shared/config.ts";
import type { Peer, GroupStatsResponse, RoadmapUpsertResponse } from "./shared/types.ts";
import { computeProjectKey } from "./shared/summarize.ts";
import { resolveProjectKey } from "./shared/project-key.ts";

const config = await loadConfig();
const BROKER_URL = brokerUrl(config);

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return config.broker_token ? { ...extra, Authorization: `Bearer ${config.broker_token}` } : extra;
}

async function brokerGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function brokerPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/**
 * KNOWN, TRACKED DUPLICATE (card 51fd7b65), not an oversight: a second
 * implementation of "find the git root", the other being server.ts's own
 * private getGitRoot(). Shipping a second producer of a helper the codebase
 * already has is the exact divergence this lot exists to close, one layer
 * down. Deferred hoist into shared/project-key.ts (resolveProjectKey's
 * home): that file was mid-review, and writing into it would have
 * invalidated an in-flight verdict. Delete this copy once it lands there.
 */
async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {
    // not a git repo
  }
  return null;
}

function formatPeerLine(p: Peer): string {
  const head = p.host && p.client_pid
    ? `[${p.group_id}] ${p.peer_id}  (${p.host} - PID: ${p.client_pid})`
    : `[${p.group_id}] ${p.peer_id}  PID:${p.pid}`;
  const statusTag = p.status === "active" ? "" : `  <${p.status}>`;
  return `${head}${statusTag}  ${p.cwd}`;
}

const cmd = process.argv[2];
const flags = process.argv.slice(3);

switch (cmd) {
  case "status": {
    try {
      const health = await brokerGet<{ status: string; peers: number; ws_clients?: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} active peer(s))`);
      if (typeof health.ws_clients === "number") {
        console.log(`WebSocket clients: ${health.ws_clients}`);
      }
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerGet<Peer[]>("/admin/peers");
        console.log("\nActive peers:");
        for (const p of peers) {
          console.log(`  ${formatPeerLine(p)}`);
          if (p.role) console.log(`         Role: ${p.role}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.project_key) console.log(`         Project: ${p.project_key}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log(`Broker is not running (or not reachable at ${BROKER_URL}).`);
    }
    break;
  }

  case "peers": {
    const includeDormant = flags.includes("--include-dormant");
    try {
      const url = includeDormant ? "/admin/peers?include_dormant=1" : "/admin/peers";
      const peers = await brokerGet<Peer[]>(url);
      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          console.log(formatPeerLine(p));
          if (p.role) console.log(`  Role: ${p.role}`);
          if (p.summary) console.log(`  Summary: ${p.summary}`);
          if (p.project_key) console.log(`  Project: ${p.project_key}`);
        }
      }
    } catch {
      console.log(`Broker is not running (or not reachable at ${BROKER_URL}).`);
    }
    break;
  }

  case "groups": {
    try {
      const stats = await brokerGet<GroupStatsResponse>("/group-stats");
      if (stats.groups.length === 0) {
        console.log("No groups with active peers.");
      } else {
        console.log("Active peers per group:");
        for (const g of stats.groups) {
          console.log(`  ${g.group_id}  ${g.active_peers}`);
        }
      }
    } catch {
      console.log(`Broker is not running (or not reachable at ${BROKER_URL}).`);
    }
    break;
  }

  case "kill-broker": {
    if (process.platform === "win32") {
      console.error("kill-broker is Linux/macOS only (uses lsof). On Windows, stop the broker process manually.");
      process.exit(1);
    }
    try {
      const health = await brokerGet<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} active peer(s). Shutting down...`);
      const proc = Bun.spawnSync(["lsof", "-ti", `:${config.port}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "roadmap-export": {
    // Prints the JSON snapshot to stdout: redirect to a file to version/backup it.
    const projectKey = flags[0];
    if (!projectKey) {
      console.error("Usage: bun cli.ts roadmap-export <project_key>  (e.g. github.com/owner/repo)");
      process.exit(1);
    }
    try {
      const dump = await brokerGet<unknown>(
        `/roadmap/export?project_key=${encodeURIComponent(projectKey)}`
      );
      console.log(JSON.stringify(dump, null, 2));
    } catch (e) {
      console.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }

  case "roadmap-import": {
    // Reads a roadmap-export JSON file and bulk-imports it (ids/timestamps kept).
    const file = flags[0];
    const byFlagIdx = flags.indexOf("--by");
    const by = byFlagIdx !== -1 ? flags[byFlagIdx + 1] : undefined;
    if (!file || !by) {
      console.error(
        "Usage: bun cli.ts roadmap-import <export.json> --by <name> [--project-key <key>] [--force]"
      );
      // Card 40ddf1f5: --by is required, not optional -- this route's author
      // is never proven (no instance_token flows through the CLI's
      // bearer-only auth), so it must be a hand-typed choice, not a silent
      // default (e.g. 'deck'), same discipline as roadmap-add's own --by.
      process.exit(1);
    }
    try {
      const dump = JSON.parse(await Bun.file(file).text()) as {
        project_key?: string;
        items?: unknown[];
      };
      const keyFlagIdx = flags.indexOf("--project-key");
      const projectKey = keyFlagIdx !== -1 ? flags[keyFlagIdx + 1] : dump.project_key;
      if (!projectKey) {
        console.error("No project_key in the file; pass --project-key <key>.");
        process.exit(1);
      }
      // --force is a deliberate, hand-typed escape hatch: it overrides the
      // default skip-every-locked-card behaviour below for the WHOLE import,
      // for an operator who is certain. Typing it here cannot happen by
      // accident. But /roadmap/import is a plain bearer-authenticated HTTP
      // route (broker.ts), so force:true remains as declarative there as
      // everything else the broker token authorizes -- this CLI verb is the
      // only caller that sets it in this repo, not the only one that could.
      // The hole that used to let any bearer-token holder silently overwrite
      // a locked card AND erase its lock columns has narrowed (defect 1+2,
      // card 40ddf1f5) to one that still requires declaring force:true out
      // loud, but has not closed: a real capability check on this route is
      // card 39c40571's scope, not this one's.
      const force = flags.includes("--force");
      const result = await brokerPost<{ imported: number; skipped: string[] }>(
        "/roadmap/import",
        { project_key: projectKey, items: dump.items ?? [], by, force }
      );
      console.log(`Imported ${result.imported} item(s) into ${projectKey}.`);
      if (result.skipped.length > 0) {
        console.log(
          `Skipped ${result.skipped.length} card(s) (locked, or inactive -- --force only overrides the lock): ${result.skipped.join(", ")}`
        );
      }
    } catch (e) {
      console.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }

  case "roadmap-add": {
    // File-based by design (agent-forge --input convention), not argv: card
    // prose is long/multi-line, and quoting it through a shell is fragile.
    // This is the sanctioned fallback when a session's own tool-list omits
    // the MCP roadmap_add tool (a harness-side snapshot gap, independent of
    // the server -- see desktop/deck-plugin/skills/roadmap-card/SKILL.md). The broker
    // token is resolved internally by loadConfig()/authHeaders(); this verb's
    // argv surface never carries it, so the caller never sees or types it.
    const inputFlagIdx = flags.indexOf("--input");
    const file = inputFlagIdx !== -1 ? flags[inputFlagIdx + 1] : undefined;
    if (!file) {
      console.error("Usage: bun cli.ts roadmap-add --input <payload.json>");
      process.exit(1);
    }
    try {
      const payload = JSON.parse(await Bun.file(file).text()) as Record<string, unknown>;
      for (const field of ["by", "title"] as const) {
        if (!payload[field] || typeof payload[field] !== "string") {
          console.error(`Payload must include a string '${field}' field.`);
          process.exit(1);
        }
      }

      // Derives its own project_key from cwd (computeProjectKey for a git
      // remote, resolveProjectKey's local:<hash> fallback otherwise) rather
      // than trusting the payload's project_key.
      // A caller-supplied value can be miscomputed or stale and would silently
      // write into the wrong project's roadmap with no error.
      const cwd = process.cwd();
      const gitRoot = await getGitRoot(cwd);
      const remoteProjectKey = await computeProjectKey(cwd);
      const derivedProjectKey = resolveProjectKey(remoteProjectKey, gitRoot, cwd);

      // A payload-declared project_key is not silently trusted NOR silently
      // dropped: a caller that still writes one (roadmap-scribe.md's
      // documented payload shape still does today, pending that page's own
      // fix) believes it is authoritative, so a MISMATCH is refused loudly,
      // before any network call, rather than overridden without a trace --
      // the same refuse-don't-diverge discipline as card c92614ed's
      // project_key checks in broker.ts. A matching value (the common case
      // today) is a no-op.
      if (
        typeof payload.project_key === "string" &&
        payload.project_key.length > 0 &&
        payload.project_key !== derivedProjectKey
      ) {
        console.error(
          `Payload's project_key ('${payload.project_key}') does not match this repo's derived key ` +
            `('${derivedProjectKey}') -- remove project_key from the payload and let this verb derive it ` +
            `from cwd, or fix the mismatch.`
        );
        process.exit(1);
      }

      // This verb cannot present an instance_token, so `by` is attributed as an
      // unproven CLI claim rather than a registered peer's identity --
      // exempting it from the guard entirely would reopen the impersonation
      // hole the guard closes.
      // Any instance_token present in the payload is dropped rather than
      // forwarded, so this verb can never be used to launder one.
      const claimed = String(payload.by);
      const { instance_token: _dropped, project_key: _droppedProjectKey, ...safePayload } = payload;
      const result = await brokerPost<RoadmapUpsertResponse>("/roadmap/upsert", {
        ...safePayload,
        project_key: derivedProjectKey,
        by: claimed.startsWith("cli:") ? claimed : `cli:${claimed}`,
      });
      console.log(JSON.stringify(result.item, null, 2));
    } catch (e) {
      console.error(`roadmap-add failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }

  default:
    console.log(`claude-peers CLI v0.4

Usage:
  bun cli.ts status                       Show broker status and all peers
  bun cli.ts peers [--include-dormant]    List peers across all groups
  bun cli.ts groups                       Show active peer counts per group
  bun cli.ts kill-broker                  Stop the broker daemon (Linux/macOS only)
  bun cli.ts roadmap-export <project_key> Print a project's roadmap as JSON (stdout)
  bun cli.ts roadmap-import <export.json> --by <name> [--project-key <key>] [--force]
                                          Bulk-import a roadmap export (ids kept);
                                          skips locked cards unless --force
  bun cli.ts roadmap-add --input <payload.json>
                                          Create one roadmap item (fallback for
                                          roadmap_add when the MCP tool is
                                          absent from a session's tool-list)

Note: 'send' is no longer available -- use the MCP send_message tool from
within Claude Code (the broker requires a valid instance_token).

Configuration: env CLAUDE_PEERS_PORT (default 7899) or settings file.
Broker URL: ${BROKER_URL}`);
}
