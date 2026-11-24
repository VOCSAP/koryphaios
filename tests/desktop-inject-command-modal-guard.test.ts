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

test('the injection refusal gives an unavailable xterm read its own reason and logs the cause', () => {
  const src = readFileSync(TILE_INJECTOR_PATH, 'utf-8')
  const body = extractBody(src, /private refusal\(id: string\): InjectRefusal \| null \{/, 'refusal()')
  expect(body).toContain("screen.status === 'unavailable'")
  expect(body).toContain("return 'screen-unavailable'")
  expect(body).toContain('${screen.reason}')
  expect(body).toContain('inspectInjectGuard(screen.snapshot)')
  expect(body).toContain("return 'needs-attention'")
  expect(body).toContain("return 'rate-limited'")
})

test('every injection refusal is a member of DirectiveOutcome, its agent-stop aliases and the Deck wire unions', () => {
  const refusals = ['refused-modal', 'screen-unavailable', 'needs-attention', 'rate-limited']
  const agentStop = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'agent-stop.ts'), 'utf-8')
  const wireTypes = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'shared', 'types.ts'), 'utf-8')
  expect(/export type DirectiveOutcome = ([^\n]+)/.exec(wireTypes)?.[1]).toContain('InjectRefusal')
  expect(agentStop).toContain('export type InjectOutcome = DirectiveOutcome')
  expect(agentStop).toContain('export type StopRefusal = InjectRefusal')
  const injectRefusals = /export type InjectRefusal = ([^\n]+)/.exec(wireTypes)?.[1] ?? ''
  const coreTypes = readFileSync(join(import.meta.dir, '..', 'shared', 'types.ts'), 'utf-8')
  for (const reason of refusals) {
    expect(injectRefusals, `InjectRefusal lacks ${reason}`).toContain(`'${reason}'`)
    expect(wireTypes.split(`'${reason}'`).length - 1, `desktop wire types carry ${reason} in InjectRefusal, DirectiveDispatch.refused and StopOutcome.result`).toBeGreaterThanOrEqual(3)
    expect(coreTypes, `DispatchRefusalReason lacks ${reason}`).toContain(`"${reason}"`)
  }
})

test('SessionService passes its turn generation to command injection', () => {
  const src = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
  const body = extractBody(
    src,
    /\binjectCommand\(\s*id: string,\s*command: string,\s*directive: SequenceWaitingDirective,\s*idleWaitMs: number = DIRECTIVE_IDLE_WAIT_MS\s*\): Promise<DirectiveOutcome> \{/,
    'SessionService.injectCommand()'
  )
  expect(body.replace(/\s+/g, ' ').trim()).toBe(
    'const started = this.queueBehindSequence(id, directive) return this.injector.inTurn(id, (isCurrent) => { started() return this.injector.injectCommand(id, command, idleWaitMs, isCurrent) })'
  )
})

test('SessionService feeds xterm before publishing data and invalidates it when PTY resize fails', () => {
  const src = readFileSync(SESSION_SERVICE_PATH, 'utf-8')
  expect(src.indexOf('this.screenGuard.feed(e.id, e.data)')).toBeLessThan(src.indexOf("this.emit('data', e)"))
  const resize = extractBody(src, /resize\(id: string, cols: number, rows: number\): void \{/, 'resize()')
  expect(resize).toContain('this.screenGuard.resize(id, cols, rows)')
  expect(resize).toContain("this.screenGuard.invalidate(id, 'PTY resize failed')")
})
