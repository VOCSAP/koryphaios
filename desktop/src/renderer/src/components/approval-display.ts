export function displayApprovalText(text: string): string {
  return text
}

export function splitCommandLine(text: string): { head: string; rest: string } {
  const nl = text.indexOf('\n')
  if (nl < 0) return { head: text, rest: '' }
  return { head: text.slice(0, nl), rest: text.slice(nl + 1) }
}
