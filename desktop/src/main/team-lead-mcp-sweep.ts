// Pure (no electron/fs import) so the startup-sweep filter for team-lead
// --mcp-config files is importable under a plain bun test run.

import { createHash } from 'node:crypto'

/**
 * Card 9d8e24f4: userData is shared across Kory instances (no
 * requestSingleInstanceLock). Hashing the project key keeps the token
 * filesystem-safe -- a git-remote-derived key can contain '/'.
 */
export function teamLeadInstanceToken(projectKey: string): string {
  return createHash('sha256').update(projectKey, 'utf-8').digest('hex').slice(0, 12)
}

/** Sole producer of the prefix, so the filename builder and the sweep filter below can't diverge on it. */
export function teamLeadMcpFilePrefix(instanceToken: string): string {
  return `team-lead-mcp-${instanceToken}-`
}

export function teamLeadMcpConfigFileName(instanceToken: string, callerId: string): string {
  return `${teamLeadMcpFilePrefix(instanceToken)}${callerId}.json`
}

/**
 * A file from another instance's project directory never matches, so a
 * startup sweep leaves it (and any live tile it backs) alone. Same applies
 * to a pre-existing unprefixed file and to a second instance sharing this
 * SAME project directory: both accumulate rather than risk deleting a live
 * sibling's file.
 */
export function isSweepableTeamLeadMcpFile(name: string, instanceToken: string): boolean {
  const prefix = teamLeadMcpFilePrefix(instanceToken)
  return name.startsWith(prefix) && name.endsWith('.json')
}

export interface TeamLeadMcpSweepDeps {
  dirExists: (dir: string) => boolean
  listFiles: (dir: string) => string[]
  removeFile: (dir: string, name: string) => void
  onFileError: (name: string, error: unknown) => void
  onScanError: (error: unknown) => void
}

/**
 * The whole startup-sweep body, fs access injected: index.ts's own
 * `sweepStaleTeamLeadMcpConfigs` has nothing left to reimplement, it only
 * wires real fs functions in -- so a divergent inline filter can't be
 * written there without replacing this call outright.
 */
export function sweepTeamLeadMcpConfigs(dir: string, instanceToken: string, deps: TeamLeadMcpSweepDeps): void {
  try {
    if (!deps.dirExists(dir)) return
    for (const name of deps.listFiles(dir)) {
      if (!isSweepableTeamLeadMcpFile(name, instanceToken)) continue
      try {
        deps.removeFile(dir, name)
      } catch (e) {
        deps.onFileError(name, e)
      }
    }
  } catch (e) {
    deps.onScanError(e)
  }
}
