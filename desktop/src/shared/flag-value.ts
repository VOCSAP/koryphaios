/**
 * Allow-list an `--agent` / `--model` flag value before it is interpolated into
 * the login-shell command line (B6 hardening). Both are identifiers; the model
 * form additionally carries the 1M-context suffix `[1m]`, so brackets are
 * permitted. Every shell metacharacter ($ ` " ' \ ; & | < > ( ) { } space
 * newline …) is rejected, so a template- / remote-supplied value cannot break
 * out of the command string (it is also double-quoted at the call site). Returns
 * '' (flag omitted) for anything outside the allow-list — the pickers only ever
 * yield valid ids, and the graph path's own `sanitizeModel` is deliberately NOT
 * reused here because it strips the `[1m]` brackets.
 */
export function sanitizeFlagValue(v: string): string {
  const t = v.trim()
  return /^[A-Za-z0-9._:@/[\]-]{1,128}$/.test(t) ? t : ''
}
