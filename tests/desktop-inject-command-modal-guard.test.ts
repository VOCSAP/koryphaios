import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractBracedBody } from './_braced-body'

const SESSION_SERVICE_PATH = join(import.meta.dir, '..', 'desktop', 'src', 'main', 'session-service.ts')
const TILE_INJECTOR_PATH = join(import.meta.dir, '..', 'desktop', 'src', 'main', 'tile-injector.ts')

function extractBody(src: string, signature: RegExp, name: string): string {
  const match = signature.exec(src)
  if (!match || match.index === undefined) throw new Error(`${name} not found`)
  return extractBracedBody(src, match.index + match[0].length - 1)
}

function twoSynchronousScreenReadsGuardBothWrites(body: string): boolean {
  const firstRead = body.indexOf('const firstRefusal = this.refusal(id)')
  const escape = body.indexOf("this.pty.write(id, '\\x1b')")
  const secondRead = body.indexOf('const secondRefusal = this.refusal(id)')
  const submit = body.indexOf('this.pty.write(id, encodeSubmittedKeystrokes(command))')
  if (firstRead < 0 || escape < 0 || secondRead < 0 || submit < 0) return false
  return firstRead < escape && escape < secondRead && secondRead < submit && !body.slice(secondRead, submit).includes('await')
}

test('injectCommand re-reads the xterm screen before each physical write', () => {
  const body = extractBody(readFileSync(TILE_INJECTOR_PATH, 'utf-8'), /async injectCommand\([^)]*\)[^{]*\{/, 'injectCommand()')
  expect(twoSynchronousScreenReadsGuardBothWrites(body)).toBe(true)
})

test('the injection refusal treats unavailable xterm reads as modal and logs their reason', () => {
  const src = readFileSync(TILE_INJECTOR_PATH, 'utf-8')
  const body = extractBody(src, /private refusal\(id: string\): DirectiveOutcome \| null \{/, 'refusal()')
  expect(body).toContain("screen.status === 'unavailable'")
  expect(body).toContain('screen unavailable ${screen.reason}')
  expect(body).toContain('inspectInjectGuard(screen.snapshot)')
  expect(body).toContain('needsAttention')
  expect(body).toContain('rateLimited')
})

test("'refused-modal' is a member of DirectiveOutcome and its agent-stop mirror", () => {
  const session = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
  const agentStop = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'agent-stop.ts'), 'utf-8')
  expect(/export type DirectiveOutcome = ([^\n]+)/.exec(session)?.[1]).toContain("'refused-modal'")
  expect(/export type InjectOutcome = ([^\n]+)/.exec(agentStop)?.[1]).toContain("'refused-modal'")
})

test('SessionService passes its turn generation to command injection', () => {
  const src = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
  const body = extractBody(src, /injectCommand\(id: string, command: string, idleWaitMs: number = DIRECTIVE_IDLE_WAIT_MS\): Promise<DirectiveOutcome> \{/, 'SessionService.injectCommand()')
  expect(body.trim()).toBe('return this.injector.inTurn(id, (isCurrent) => this.injector.injectCommand(id, command, idleWaitMs, isCurrent))')
})

test('SessionService feeds xterm before publishing data and invalidates it when PTY resize fails', () => {
  const src = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
  expect(src.indexOf('this.screenGuard.feed(e.id, e.data)')).toBeLessThan(src.indexOf("this.emit('data', e)"))
  const resize = extractBody(src, /resize\(id: string, cols: number, rows: number\): void \{/, 'resize()')
  expect(resize).toContain('this.screenGuard.resize(id, cols, rows)')
  expect(resize).toContain("this.screenGuard.invalidate(id, 'PTY resize failed')")
})
