import { expect, test } from 'bun:test'
import { loginEnvSeed, loginShell, parseLoginEnv } from '../desktop/src/main/serve-login-env.ts'

const NUL = String.fromCharCode(0)
const NONCE = 'f00d'
const BEGIN = `__KORY_SERVE_ENV_BEGIN_${NONCE}__`
const END = `__KORY_SERVE_ENV_END_${NONCE}__`

function capture(records: string[], before = '', after = ''): string {
  return `${before}\n${BEGIN}\n${records.map((record) => `${record}${NUL}`).join('')}${END}\n${after}`
}

test('parses NUL-separated records whose values hold newlines and equals signs', () => {
  const env = parseLoginEnv(capture(['PATH=/usr/bin', 'MULTI=line1\nline2', 'EQ=a=b=c', 'EMPTY=']), NONCE)

  expect(env).toEqual({ PATH: '/usr/bin', MULTI: 'line1\nline2', EQ: 'a=b=c', EMPTY: '' })
})

test('ignores a profile banner printed before the capture and output after it', () => {
  const env = parseLoginEnv(capture(['PATH=/usr/bin', 'PORT=3000'], 'WELCOME banner without newline', 'logout banner\n'), NONCE)

  expect(env).toEqual({ PATH: '/usr/bin', PORT: '3000' })
})

test('refuses an empty capture and a capture without PATH', () => {
  expect(() => parseLoginEnv(capture([]), NONCE)).toThrow('is empty')
  expect(() => parseLoginEnv(capture(['PORT=3000', 'HOME=/home/op']), NONCE)).toThrow('has no PATH')
})

test('captures through the operator shell only when /etc/shells lists it by absolute path', () => {
  const etcShells = '# List of acceptable shells\n/bin/sh\n/bin/zsh\n  /usr/bin/fish  \nbash\n'

  expect(loginShell('/bin/zsh', etcShells)).toBe('/bin/zsh')
  expect(loginShell('/usr/bin/fish', etcShells), 'surrounding blanks in /etc/shells').toBe('/usr/bin/fish')
  expect(loginShell('/opt/evil/shell', etcShells), 'absolute but unlisted').toBe('/bin/sh')
  expect(loginShell('bash', etcShells), 'listed but relative').toBe('/bin/sh')
  expect(loginShell(undefined, etcShells), 'SHELL unset').toBe('/bin/sh')
  expect(loginShell('/bin/zsh', ''), 'no /etc/shells').toBe('/bin/sh')
})

test('refuses an output without its start marker on its own line', () => {
  const glued = `WELCOME${BEGIN}\nPORT=3000${NUL}${END}\n`

  expect(() => parseLoginEnv(glued, NONCE)).toThrow('no start marker')
  expect(() => parseLoginEnv(capture(['PATH=/usr/bin']), 'other')).toThrow('no start marker')
})

test('refuses a truncated capture instead of returning a partial environment', () => {
  expect(() => parseLoginEnv(`\n${BEGIN}\nPORT=3000${NUL}HOST=`, NONCE)).toThrow('no end marker')
  expect(() => parseLoginEnv(`\n${BEGIN}\nPORT=3000${NUL}HOST=x${END}\n`, NONCE)).toThrow('truncated')
  expect(() => parseLoginEnv(capture(['PORT=3000', 'no-name-here']), NONCE)).toThrow('without a name')
  expect(() => parseLoginEnv(capture(['=value']), NONCE)).toThrow('without a name')
})

test('seeds a login capture with the login identity and a system PATH, never a Deck variable', () => {
  const seed = loginEnvSeed({
    HOME: '/home/op',
    USER: 'op',
    LOGNAME: 'op',
    SHELL: '/bin/zsh',
    LANG: 'fr_FR.UTF-8',
    LC_ALL: 'C',
    TMPDIR: '/tmp/op',
    PATH: '/deck/bin',
    CLAUDE_PEERS_FORCE_GROUP: 'secret-group',
    ELECTRON_RUN_AS_NODE: '1',
    UNSET: undefined
  })

  expect(seed).toEqual({
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: '/home/op',
    USER: 'op',
    LOGNAME: 'op',
    SHELL: '/bin/zsh',
    LANG: 'fr_FR.UTF-8',
    LC_ALL: 'C',
    TMPDIR: '/tmp/op'
  })
})
