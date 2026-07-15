// Project launchCommand hardening (PLAN C19). A repo can carry
// .claude/claude-peers/config.json with its own `launchCommand` — which the
// Deck would run in every PTY it spawns for that project. That is arbitrary
// command execution on clone, so a PROJECT-sourced launchCommand now requires
// a one-time operator approval: the command's hash is remembered per
// project_key in the app state; a different command (different hash) asks
// again; refusal falls back to the global/default command.
//
// Node builtins only (no electron) — index.ts supplies the actual dialog as
// the injected `confirm` callback, tests inject a stub.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function commandHash(command: string): string {
  return createHash('sha256').update(command.trim(), 'utf-8').digest('hex')
}

/** { [project_key]: approved command sha256 } */
export function readApprovals(file: string): Record<string, string> {
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function isApproved(file: string, projectKey: string, command: string): boolean {
  return readApprovals(file)[projectKey] === commandHash(command)
}

export function approve(file: string, projectKey: string, command: string): void {
  const all = readApprovals(file)
  all[projectKey] = commandHash(command)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(all, null, 2), 'utf-8')
}

export interface LaunchApprovalResult {
  /** The command sessions should actually run. */
  command: string
  /** Where it came from after the check. */
  source: 'project' | 'fallback'
  /** True when the operator was prompted this time. */
  prompted: boolean
}

/**
 * Gate a PROJECT-sourced launchCommand behind the per-project approval.
 * `confirm` is called only on first use / hash change; returning false keeps
 * the fallback (global/default) command and persists nothing, so the operator
 * is asked again next launch.
 */
export function resolveApprovedLaunchCommand(opts: {
  projectKey: string
  /** launchCommand found in the PROJECT config. */
  projectCommand: string
  /** Global/default command used when refused. */
  fallback: string
  approvalsFile: string
  confirm: (command: string) => boolean
}): LaunchApprovalResult {
  if (isApproved(opts.approvalsFile, opts.projectKey, opts.projectCommand)) {
    return { command: opts.projectCommand, source: 'project', prompted: false }
  }
  if (opts.confirm(opts.projectCommand)) {
    approve(opts.approvalsFile, opts.projectKey, opts.projectCommand)
    return { command: opts.projectCommand, source: 'project', prompted: true }
  }
  return { command: opts.fallback, source: 'fallback', prompted: true }
}
