// Which addresses count as "our own network", in ONE place.
//
// There were two of these — one in the ntfy protocol, one in the mobile
// shell's QR parser — and they disagreed: only one knew about `.localhost`,
// only the other knew about the Tailscale range. A self-hosted ntfy on a
// tailnet was therefore rejected as "not local" and forced to HTTPS, while the
// companion happily accepted the identical address. Same question, same repo,
// two answers.
//
// Dependency-free on purpose: the mobile shell bundles it into a WebView.

/**
 * RFC1918 / loopback / ULA / link-local, plus the Tailscale CGNAT range.
 *
 * 100.64/10 is in because a tailnet is, for this feature's purposes, the same
 * trust domain as the LAN: it is how companion mode keeps working in roaming
 * without a code change (EXPLORATION §4.4).
 */
export function isPrivateHost(hostname: string): boolean {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || h === "::1") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}
