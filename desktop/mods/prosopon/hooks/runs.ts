export const MAX_RUN_NAMES = 4

const MAX_TOOL_NAME_LENGTH = 64
const MCP_PREFIX = 'mcp__'
// A subagent call keeps its native row, and agents launched together share one native group row.
const AGENT_TOOLS = new Set(['Agent', 'Task'])

export type Run = {
  ids: string[]
  names: string[]
  errors: number
  running: string | undefined
}

type Fields = Record<string, unknown>

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null
}

function isToolName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOOL_NAME_LENGTH) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x21 || code > 0x7e) return false
  }
  return true
}

function isBlankText(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === ''
}

// The name a run shows: an MCP tool by its server, as its native `Called <server>` row does.
export function shortToolName(name: string): string {
  if (!name.startsWith(MCP_PREFIX)) return name
  const server = name.slice(MCP_PREFIX.length).split('__')[0]
  return server === undefined || server === '' ? name : server
}

export function toolUseIds(messages: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(messages)) return ids
  for (const message of messages) {
    if (!isObject(message) || message.role !== 'assistant') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_use') continue
      const id = block.id
      if (typeof id === 'string') ids.add(id)
    }
  }
  return ids
}

export function computeRuns(messages: unknown, live: ReadonlySet<string>): Map<string, Run> {
  const runOf = new Map<string, Run>()
  if (!Array.isArray(messages)) return runOf
  const closed: Array<{ ids: string[]; names: string[] }> = []
  const answered = new Set<string>()
  const errored = new Set<string>()
  let open = { ids: [] as string[], names: [] as string[], valid: true }
  const close = (): void => {
    if (open.valid && open.ids.length > 1) closed.push({ ids: open.ids, names: open.names })
    open = { ids: [], names: [], valid: true }
  }

  for (const message of messages) {
    if (!isObject(message)) {
      close()
      continue
    }
    const role = message.role
    const content = message.content
    if (typeof content === 'string') {
      if (!isBlankText(content)) close()
      continue
    }
    if (!Array.isArray(content)) {
      close()
      continue
    }
    const blocks: Fields[] = []
    for (const block of content) {
      if (!isObject(block)) {
        close()
        continue
      }
      blocks.push(block)
    }
    const types = blocks.map(block => block.type)
    if (role === 'assistant') {
      blocks.forEach((block, index) => {
        const type = types[index]
        if (type === 'thinking' || type === 'redacted_thinking') return
        if (type === 'text') {
          if (!isBlankText(block.text)) close()
          return
        }
        if (type !== 'tool_use') {
          close()
          return
        }
        const id = block.id
        const name = block.name
        if (typeof id !== 'string' || !live.has(id) || (typeof name === 'string' && AGENT_TOOLS.has(name))) {
          close()
          return
        }
        open.ids.push(id)
        if (isToolName(name)) open.names.push(shortToolName(name))
        else open.valid = false
      })
    } else if (role === 'user') {
      const carriesResults = types.includes('tool_result')
      blocks.forEach((block, index) => {
        const type = types[index]
        if (type === 'tool_result') {
          const id = block.tool_use_id
          if (typeof id !== 'string') return
          answered.add(id)
          if (block.is_error === true) errored.add(id)
          return
        }
        if (carriesResults) return
        if (type === 'text' && isBlankText(block.text)) return
        close()
      })
    } else {
      close()
    }
  }
  close()

  for (const { ids, names } of closed) {
    const pending = ids.findIndex(id => !answered.has(id))
    const run: Run = {
      ids,
      names,
      errors: ids.filter(id => errored.has(id)).length,
      running: pending === -1 ? undefined : names[pending],
    }
    for (const id of ids) runOf.set(id, run)
  }
  return runOf
}

export function runSummary(run: Run): string {
  const counts = new Map<string, number>()
  for (const name of run.names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  const shown = ranked.slice(0, MAX_RUN_NAMES).map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
  if (ranked.length > MAX_RUN_NAMES) shown.push(`+${ranked.length - MAX_RUN_NAMES} more`)
  let summary = `${run.ids.length} calls: ${shown.join(', ')}`
  if (run.errors > 0) summary += `, ${run.errors} ${run.errors === 1 ? 'error' : 'errors'}`
  if (run.running !== undefined) summary += ` · running ${run.running}`
  return summary
}
