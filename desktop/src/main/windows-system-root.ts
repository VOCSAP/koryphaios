// The one place SystemRoot becomes a System32 path. A relative, empty or
// dot-dot SystemRoot would let Windows resolve the binary from the working
// directory, which may be a cloned repository. Pure: win32 path semantics on
// every platform, so it is unit-testable anywhere.

import { win32 } from 'node:path'

const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/
const DOT_DOT_SEGMENT_RE = /(^|[\\/])\.\.([\\/]|$)/

export type System32Dir = { ok: true; dir: string } | { ok: false; reason: 'not-absolute' | 'dot-dot' }

export function system32Dir(systemRoot: string | undefined): System32Dir {
  if (!systemRoot || !WINDOWS_ABSOLUTE_RE.test(systemRoot)) return { ok: false, reason: 'not-absolute' }
  if (DOT_DOT_SEGMENT_RE.test(systemRoot)) return { ok: false, reason: 'dot-dot' }
  return { ok: true, dir: win32.join(systemRoot, 'System32') }
}
