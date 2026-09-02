// Demo-driver agent's bridge to the Deck's embedded browser: a dependency-free
// MCP stdio server forwarding every tool call to the per-run demo-control
// loopback endpoint.
// Runs under plain Node (ELECTRON_RUN_AS_NODE=1).

import { createInterface } from 'node:readline'

const CONTROL_URL = process.env.DEMO_CONTROL_URL ?? ''
const CONTROL_TOKEN = process.env.DEMO_CONTROL_TOKEN ?? ''

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

const SELECTOR_PROP = {
  type: 'string',
  description:
    'CSS selector from demo_read (prefer data-testid/id/aria-label selectors over structural paths).'
} as const

const TOOLS = [
  {
    name: 'demo_read',
    description:
      'Structured snapshot of the page currently shown in the embedded browser: url, title, a text excerpt, and the interactive elements (tag, visible text, CSS selector). Call this FIRST, and again after any navigation or click, before acting.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'demo_navigate',
    description: 'Load an http(s) URL in the embedded browser and wait for the page to settle.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL to load.' } },
      required: ['url']
    }
  },
  {
    name: 'demo_click',
    description:
      'Click an element (real input events: the element is scrolled into view, hover/active states show on the recording). Fails when the selector matches nothing after a short wait.',
    inputSchema: {
      type: 'object',
      properties: { selector: SELECTOR_PROP },
      required: ['selector']
    }
  },
  {
    name: 'demo_type',
    description:
      'Type text with realistic keystroke pacing (visible on the recording). Focuses `selector` first when given, else types into the focused element. press_enter submits at the end.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type (max 2000 chars).' },
        selector: SELECTOR_PROP,
        press_enter: { type: 'boolean', description: 'Press Enter after typing (default false).' }
      },
      required: ['text']
    }
  },
  {
    name: 'demo_wait',
    description:
      'Pause the scenario: ms (≤ 15000) for pacing between demo beats, or selector to wait until an element appears.',
    inputSchema: {
      type: 'object',
      properties: {
        ms: { type: 'number', description: 'Milliseconds to wait (viewer-pacing pauses).' },
        selector: { ...SELECTOR_PROP, description: 'Wait until this selector matches (≤ 15 s).' }
      }
    }
  }
]

async function callControl(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${CONTROL_URL}/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CONTROL_TOKEN}`
    },
    body: JSON.stringify({ tool, args })
  })
  const parsed = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
  if (!parsed.ok) throw new Error(parsed.error ?? `control error ${res.status}`)
  return parsed.result
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id: JsonRpcRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id: JsonRpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case 'initialize':
      return reply(req.id, {
        protocolVersion:
          (req.params?.protocolVersion as string | undefined) ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'demo-browser', version: '0.1.0' },
        instructions:
          'You drive the embedded browser of the Koryphaios desktop app while the screen is being RECORDED for a product demo. These five demo_* tools are your only way to act; the recording shows exactly what the browser pane displays. Read the page first (demo_read), then act in short, deliberate beats with demo_wait pauses so a viewer can follow.'
      })
    case 'ping':
      return reply(req.id, {})
    case 'tools/list':
      return reply(req.id, { tools: TOOLS })
    case 'tools/call': {
      const name = req.params?.name as string
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const result = await callControl(name, args)
        return reply(req.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        })
      } catch (e) {
        return reply(req.id, {
          content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true
        })
      }
    }
    default:
      // Notifications (no id) are ignored; unknown requests get an error back.
      if (req.id !== undefined && req.id !== null) {
        replyError(req.id, -32601, `method not found: ${req.method}`)
      }
  }
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let req: JsonRpcRequest
  try {
    req = JSON.parse(text) as JsonRpcRequest
  } catch {
    return // skip malformed frames
  }
  void handle(req)
})
rl.on('close', () => process.exit(0))
