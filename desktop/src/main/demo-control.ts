// Demo control endpoint (REC scripted-scenario lot): a loopback HTTP server,
// started PER DEMO RUN by the Electron main process, that lets the one-shot
// demo-driver agent act on the embedded browser through the demo-browser MCP
// bridge (desktop/mcp/demo-browser-mcp.ts).
//
// Security model — deliberately NOT the deck-control endpoint:
// - The supervisor token grants spawn/close powers; the demo agent gets a
//   SEPARATE server with a token minted per run and a toolset limited to the
//   embedded browser pane (navigate/click/type/read/wait). Least privilege:
//   a runaway demo agent can at worst click around one webview.
// - 127.0.0.1 only, random port; the pair travels only in the generated
//   --mcp-config file of that single `claude -p` invocation.
// - A step cap bounds runaway loops; the server closes with the run.
//
// Dependency-injected (no electron imports) so dispatch + guards are
// unit-testable under `bun test`; the real deps are the BrowserDriver
// (browser-drive.ts) bound to the webview's WebContents.

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

/** Tool calls allowed in one demo run — beyond this the agent must wrap up. */
export const DEMO_STEP_CAP = 120

export interface DemoControlDeps {
  navigate(url: string): Promise<unknown>
  click(selector: string): Promise<unknown>
  /** Types into the focused element (or `selector` after focusing it). */
  type(text: string, opts: { selector?: string; pressEnter?: boolean }): Promise<unknown>
  /** Structured page snapshot: url, title, text excerpt, interactive elements. */
  read(): Promise<unknown>
  wait(opts: { ms?: number; selector?: string }): Promise<unknown>
}

export interface DemoControlServer {
  url: string
  token: string
  close(): void
}

type ToolArgs = Record<string, unknown>

function str(args: ToolArgs, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

/** Reminder text attached once `actionsSinceRead` reaches this many blind actions. */
const STALE_READ_THRESHOLD = 3

/** undefined below the threshold; otherwise the "N actions since your last demo_read" nudge. */
function staleReadReminder(actionsSinceRead: number): string | undefined {
  if (actionsSinceRead < STALE_READ_THRESHOLD) return undefined
  return `${actionsSinceRead} actions since your last demo_read — read the page before continuing so the recording shows real state, not guesses.`
}

/**
 * Wrap a raw dep result with a reminder string, or return it untouched when
 * there is none to attach. A plain object gets the reminder spread in (so it
 * still reads naturally alongside the tool's own fields); anything else
 * (string, number, array, null) is wrapped as { result, reminder } since
 * there is no object to extend. Bit-identical passthrough when no reminder.
 */
function withReminder(result: unknown, reminder: string | undefined): unknown {
  if (!reminder) return result
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), reminder }
  }
  return { result, reminder }
}

export function startDemoControl(
  deps: DemoControlDeps,
  opts: { port?: number } = {}
): Promise<DemoControlServer> {
  const token = randomBytes(24).toString('hex')
  let steps = 0
  // doop §4.1's "result nudge" layer: DEMO_SYSTEM_PROMPT already tells the
  // agent to read the page after every navigation, but nothing re-asserted
  // that contract at the moment the agent actually deviates from it. Track
  // how many navigate/click/type calls have happened since the last
  // demo_read and fold a short reminder into the tool RESULT itself (surfaced
  // verbatim to the agent via demo-browser-mcp.ts's JSON.stringify) so the
  // nudge lands exactly when it is needed instead of only once at the start.
  let actionsSinceRead = 0

  async function dispatch(tool: string, args: ToolArgs): Promise<unknown> {
    if (++steps > DEMO_STEP_CAP) {
      throw new Error(
        `step cap: this demo run already made ${DEMO_STEP_CAP} tool calls — end the scenario now`
      )
    }
    switch (tool) {
      case 'demo_navigate': {
        const url = str(args, 'url')
        if (!url) throw new Error('url is required')
        const result = await deps.navigate(url)
        actionsSinceRead++
        return withReminder(
          result,
          'The page just changed — call demo_read before your next action so your selectors describe what is actually there.'
        )
      }
      case 'demo_click': {
        const selector = str(args, 'selector')
        if (!selector) throw new Error('selector is required')
        const result = await deps.click(selector)
        actionsSinceRead++
        return withReminder(result, staleReadReminder(actionsSinceRead))
      }
      case 'demo_type': {
        const text = typeof args['text'] === 'string' ? (args['text'] as string) : ''
        if (!text) throw new Error('text is required')
        const result = await deps.type(text, {
          selector: str(args, 'selector') || undefined,
          pressEnter: args['press_enter'] === true
        })
        actionsSinceRead++
        return withReminder(result, staleReadReminder(actionsSinceRead))
      }
      case 'demo_read':
        actionsSinceRead = 0
        return deps.read()
      case 'demo_wait': {
        const ms = typeof args['ms'] === 'number' ? (args['ms'] as number) : undefined
        const selector = str(args, 'selector') || undefined
        if (ms === undefined && !selector) throw new Error('ms or selector is required')
        return deps.wait({ ms, selector })
      }
      default:
        throw new Error(`unknown tool: ${tool}`)
    }
  }

  const server: Server = createServer((req, res) => {
    const deny = (code: number, msg: string): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: msg }))
    }
    if (req.headers.authorization !== `Bearer ${token}`) return deny(401, 'unauthorized')
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    if (req.method !== 'POST' || req.url !== '/call') return deny(404, 'not found')

    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 64 * 1024) req.destroy() // oversized payload
    })
    req.on('end', () => {
      void (async () => {
        try {
          const parsed = JSON.parse(body) as { tool?: string; args?: ToolArgs }
          if (!parsed.tool) return deny(400, 'tool is required')
          const result = await dispatch(parsed.tool, parsed.args ?? {})
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, result }))
        } catch (e) {
          deny(400, e instanceof Error ? e.message : String(e))
        }
      })()
    })
  })

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') return reject(new Error('no address'))
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        token,
        close: () => server.close()
      })
    })
  })
}
