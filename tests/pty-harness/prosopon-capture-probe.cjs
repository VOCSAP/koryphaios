// Records the PTY bytes of a real Claude Code session rendered by a working copy of Prosopon, as
// [{t, data}] fixtures. The model is a LOCAL mock of the Messages API on 127.0.0.1 (synthetic K2-*
// prompts): no credential is used. Recapture of the committed corpus (CC 2.1.306, choregos 432ab5e):
//   git archive 432ab5e plugins/prosopon | tar -x -C <work>   (run inside the choregos clone)
//   ELECTRON_RUN_AS_NODE=1 PROBE_CLAUDE=<abs claude.exe> PROBE_PLUGIN_DIR=<work>/plugins/prosopon PROBE_COMMIT=432ab5e
//   PROBE_CWD=C:/Users/Public/k2probe/project PROBE_OUT=<dir> <electron binary of desktop/node_modules> <this file>
// That cwd is the path painted in the corpus (same line wraps at 40 columns); it must be absent, empty, or
// holding only the probe's own marker, because the probe trusts the folder and a planted settings or MCP
// file there would run: it is restricted to the current user and rechecked before every launch. Stock quota: PROBE_PLUGIN=0 PROBE_SCENARIOS=quota PROBE_WIDTHS=80.
// Never load desktop/mods (--plugin-dir writes into the folder). Scan <dir> for secrets and read each
// checkpoint screen yourself to extend the verdict oracle. PROBE_NATIVE_CURSOR=0 shows the guard refusing
// every composer. Other env: PROBE_WIDTHS, PROBE_SCENARIOS, PROBE_WORK.
'use strict'
const http = require('node:http')
const { spawnSync } = require('node:child_process')
const { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const REPO = join(__dirname, '..', '..')
const CLAUDE = process.env.PROBE_CLAUDE || 'claude'
const PLUGIN_DIR = process.env.PROBE_PLUGIN_DIR || ''
const COMMIT = process.env.PROBE_COMMIT || 'unknown'
const WIDTHS = (process.env.PROBE_WIDTHS || '40,80,120').split(',').map(Number)
const SCENARIOS = (process.env.PROBE_SCENARIOS || 'flow,resume,permission,quota').split(',')
const WITH_PLUGIN = process.env.PROBE_PLUGIN !== '0'
const NATIVE_CURSOR = process.env.PROBE_NATIVE_CURSOR !== '0'
const WORK = process.env.PROBE_WORK || mkdtempSync(join(tmpdir(), 'prosopon-probe-'))
const OUT = process.env.PROBE_OUT || join(WORK, 'out')
const ESC = '\u001b'
const CWD_MARKER = '.prosopon-probe-owned'

function refuseForeignFiles(cwd) {
  const foreign = readdirSync(cwd).filter((entry) => entry !== CWD_MARKER)
  if (foreign.length > 0) {
    console.error(`PROBE-UNAVAILABLE ${cwd} holds ${foreign.slice(0, 3).join(', ')}: the probe trusts this folder, so a file planted in it would run`)
    process.exit(2)
  }
}

function lockDown(dir) {
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o700)
    return
  }
  const user = process.env.USERNAME
  const result = user ? spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { encoding: 'utf8' }) : null
  if (!result || result.status !== 0) {
    console.error(`PROBE-UNAVAILABLE ${dir} could not be restricted to the current user: ${result ? result.stdout + result.stderr : 'USERNAME is unset'}`)
    process.exit(2)
  }
}

function prepareCwd() {
  const given = process.env.PROBE_CWD
  const base = given || mkdtempSync(join(process.env.PUBLIC || tmpdir(), 'prosopon-probe-'))
  mkdirSync(base, { recursive: true })
  lockDown(base)
  const cwd = given || join(base, 'project')
  mkdirSync(cwd, { recursive: true })
  refuseForeignFiles(cwd)
  writeFileSync(join(cwd, CWD_MARKER), '')
  return cwd
}
const CWD = prepareCwd()

let pty
try {
  pty = require(join(REPO, 'desktop', 'node_modules', 'node-pty'))
} catch (e) {
  console.error('PROBE-UNAVAILABLE node-pty could not be loaded:', e && e.message)
  process.exit(2)
}
if (WITH_PLUGIN && !PLUGIN_DIR) {
  console.error('PROBE-UNAVAILABLE PROBE_PLUGIN_DIR is required unless PROBE_PLUGIN=0')
  process.exit(2)
}

const version = (spawnSync(CLAUDE, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' && CLAUDE === 'claude' }).stdout || 'unknown').trim().split(' ')[0]

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}
const start = () => ['message_start', { type: 'message_start', message: { id: 'msg_probe', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }]
const textEvents = (text) => [
  start(),
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
  ['message_stop', { type: 'message_stop' }]
]
const toolEvents = (name, input) => [
  start(),
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_probe', name, input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
  ['message_stop', { type: 'message_stop' }]
]
function lastUser(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const content = messages[i].content
    if (typeof content === 'string') return { text: content, toolResult: false }
    const text = content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    return { text, toolResult: content.some((block) => block.type === 'tool_result') && !/K2-[A-Z]+/.test(text) }
  }
  return { text: '', toolResult: false }
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch (error) {
      console.error('mock: unparsable request body', String(error))
    }
    if (req.method !== 'POST' || !/\/v1\/messages(\?|$)/.test(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'probe mock: no such route' } }))
      return
    }
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_probe', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'side request' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 } }))
      return
    }
    const last = lastUser(body)
    const main = Array.isArray(body.tools) && body.tools.length > 3
    if (!main) return sse(res, textEvents('side request'))
    if (last.toolResult) return sse(res, textEvents('Done, the file was handled.'))
    if (/K2-BASH/.test(last.text)) return sse(res, toolEvents('Bash', { command: 'touch k2-probe.txt', description: 'Create a probe file' }))
    if (/K2-ASK/.test(last.text)) {
      return sse(res, toolEvents('AskUserQuestion', { questions: [{ question: 'Which colour should the probe use?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'The colour red' }, { label: 'Blue', description: 'The colour blue' }] }] }))
    }
    if (/K2-SLOW/.test(last.text)) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const events = textEvents('Working through the synthetic task step by step, which takes a while.')
      for (const [name, data] of events.slice(0, 3)) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      setTimeout(() => {
        for (const [name, data] of events.slice(3)) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
        res.end()
      }, 9000)
      return
    }
    if (/K2-LONG/.test(last.text)) {
      return sse(res, textEvents('A synthetic answer long enough to wrap at every probed width: the quick brown fox jumps over the lazy dog, and then jumps back over the same dog again.\n\n- first synthetic bullet\n- second synthetic bullet'))
    }
    return sse(res, textEvents('Hello from the synthetic answer.'))
  })
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const type = (text) => [{ send: text }, { wait: 500 }, { send: '\r' }]

async function capture({ profile, cols, plugin, extraArgs = [], steps }) {
  const profileDir = join(WORK, `profile-${profile}`)
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  if (!existsSync(join(profileDir, '.claude.json'))) {
    writeFileSync(join(profileDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, autoUpdates: false, theme: 'dark' }))
  }
  const settings = join(WORK, 'tile-settings.json')
  writeFileSync(settings, JSON.stringify({ tui: 'default', env: { CLAUDE_CODE_NO_FLICKER: '0' } }))

  const env = {}
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'HOME', 'LANG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: profileDir,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_AUTH_TOKEN: randomUUID(),
    TERM: 'xterm-256color'
  })
  if (NATIVE_CURSOR) env.CLAUDE_CODE_NATIVE_CURSOR = '1'

  const args = ['--settings', settings, '--model', 'haiku', '--permission-mode', 'default', ...extraArgs]
  if (plugin) args.push('--plugin-dir', PLUGIN_DIR)

  const chunks = []
  let recording = true
  let exited = false
  const t0 = Date.now()
  refuseForeignFiles(CWD)
  const proc = pty.spawn(CLAUDE, args, { name: 'xterm-256color', cols, rows: 40, cwd: CWD, env })
  proc.onData((data) => {
    if (recording) chunks.push({ t: Date.now() - t0, data })
  })
  proc.onExit(() => {
    exited = true
  })
  chunks.push({ t: 0, data: `\n########## GEOMETRY [${cols},40] ##########` })
  for (const step of steps) {
    if (exited) break
    if ('wait' in step) await sleep(step.wait)
    else if ('send' in step) proc.write(step.send)
    else chunks.push({ t: Date.now() - t0, data: `\n########## ${step.marker} ##########` })
  }
  recording = false
  try {
    proc.kill()
  } catch (error) {
    console.error('proc.kill failed (already exited?):', String(error))
  }
  await sleep(300)
  return chunks
}

const trust = [{ wait: 5000 }, { send: `${ESC}[B` }, { wait: 500 }, { send: '\r' }, { wait: 5000 }]

function writeSessionWithQuotaLine(profile) {
  const dir = join(WORK, `profile-${profile}`, 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const sessionId = randomUUID()
  const userUuid = randomUUID()
  const common = { userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId, version, gitBranch: 'HEAD' }
  const lines = [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'permission-mode', permissionMode: 'default', sessionId },
    { parentUuid: null, isSidechain: false, promptId: randomUUID(), type: 'user', message: { role: 'user', content: 'Continue the synthetic task' }, uuid: userUuid, timestamp: '2026-01-01T00:00:00.000Z', permissionMode: 'default', origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: 1, turnIndex: 1 }, ...common },
    {
      parentUuid: userUuid,
      isSidechain: false,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { id: randomUUID(), model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', stop_sequence: '', type: 'message', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: "You've hit your session limit · resets 7:10pm (Europe/Paris) · progress saved" }] },
      error: 'rate_limit',
      isApiErrorMessage: true,
      session_id: sessionId,
      ...common
    }
  ]
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function save(name, chunks) {
  mkdirSync(OUT, { recursive: true })
  const file = join(OUT, name)
  writeFileSync(file, JSON.stringify(chunks))
  console.log(`wrote ${file} (${chunks.length} chunks)`)
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const prefix = WITH_PLUGIN ? `prosopon-${COMMIT}` : 'stock'
  for (const cols of WIDTHS) {
    const base = { cols, plugin: WITH_PLUGIN }
    const name = (scenario) => `${prefix}-${scenario}-${cols}c-${version}.json`
    if (SCENARIOS.includes('flow')) {
      const profile = `flow${cols}`
      await capture({ ...base, profile, steps: trust })
      save(
        name('flow'),
        await capture({
          ...base,
          profile,
          steps: [
            { wait: 6000 }, { marker: 'STARTUP' },
            ...type('K2-LONG tell me something'), { wait: 7000 }, { marker: 'AFTER-TURN' },
            ...type('K2-SLOW take your time'), { wait: 3500 }, { marker: 'WORKING' },
            { send: ESC }, { wait: 3000 }, { marker: 'AFTER-PAUSE' },
            ...type('K2-BASH touch'), { wait: 7000 }, { marker: 'PERMISSION' },
            { send: ESC }, { wait: 4000 }, { marker: 'AFTER-INTERRUPT' },
            ...type('K2-ASK pick'), { wait: 7000 }, { marker: 'ASK-QUESTION' },
            { send: ESC }, { wait: 5000 }, { marker: 'AFTER-ASK' },
            { send: '/model' }, { wait: 1500 }, { marker: 'SLASH-MENU' },
            { send: '\r' }, { wait: 2500 }, { marker: 'MODEL-PICKER' },
            { send: ESC }, { wait: 2000 }, { marker: 'AFTER-PICKER' },
            ...type('/clear'), { wait: 3000 }, { marker: 'AFTER-CLEAR' }, { wait: 500 }
          ]
        })
      )
    }
    if (SCENARIOS.includes('resume')) {
      const profile = `resume${cols}`
      await capture({ ...base, profile, steps: trust })
      await capture({ ...base, profile, steps: [{ wait: 6000 }, ...type('K2-LONG tell me something'), { wait: 7000 }, ...type('K2-TEXT a second synthetic turn'), { wait: 6000 }] })
      save(
        name('resume'),
        await capture({ ...base, profile, extraArgs: ['--continue'], steps: [{ wait: 7000 }, { marker: 'RESUMED' }, ...type('K2-TEXT after resume'), { wait: 6000 }, { marker: 'AFTER-RESUMED-TURN' }, { wait: 500 }] })
      )
    }
    if (SCENARIOS.includes('permission')) {
      const profile = `permission${cols}`
      await capture({ ...base, profile, steps: trust })
      save(
        name('permission'),
        await capture({ ...base, profile, steps: [{ wait: 6000 }, { marker: 'STARTUP' }, ...type('K2-LONG tell me something'), { wait: 7000 }, { marker: 'AFTER-TURN' }, ...type('K2-BASH touch'), { wait: 7000 }, { marker: 'PERMISSION' }, { wait: 500 }] })
      )
    }
    if (SCENARIOS.includes('quota')) {
      const profile = `quota${cols}${WITH_PLUGIN ? '' : 'stock'}`
      await capture({ ...base, profile, steps: trust })
      writeSessionWithQuotaLine(profile)
      save(name('quota'), await capture({ ...base, profile, extraArgs: ['--continue'], steps: [{ wait: 7000 }, { marker: 'QUOTA' }, { wait: 500 }] }))
    }
  }
}

main()
  .catch((error) => {
    console.error('PROBE-FAILED', error)
    process.exitCode = 1
  })
  .finally(() => {
    server.close()
    setTimeout(() => process.exit(process.exitCode || 0), 200)
  })
