import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TURN_SIGNAL_LIMITS, isWireText } from '../desktop/hooks/turn-signal-wire'
import { assembleSkillSequence, BUILTIN_COMMAND_TABLES, NATIVE_COMMANDS, type SkillMoment } from '../desktop/src/main/session-skill-sequence'
import { readSessionSkills, writeSessionSkills } from '../desktop/src/main/session-skills'
import { startSequence, stepArgs, type CommandClass, type PlanStep } from '../desktop/src/main/session-turn-sequence'
import { validateCommandLine, type CommandLineRefusal } from '../desktop/src/shared/session-command-line'
import { SESSION_COMMAND_LIMITS } from '../desktop/src/shared/session-skill-limits'
import type { SessionSkillSettings } from '../desktop/src/shared/types'

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-skill-sequence-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const settings = (commands: Partial<SessionSkillSettings['commands']> = {}): SessionSkillSettings => ({
  version: 3,
  addendum: { start: '', end: '', stop: '' },
  storage: { mode: 'kory', instructions: '' },
  commands: { start: [], end: [], stop: [], ...commands }
})

function steps(result: ReturnType<typeof assembleSkillSequence>) {
  if ('refused' in result) throw new Error(`refused: ${result.reason}`)
  return result.steps
}

const commandsOf = (result: ReturnType<typeof assembleSkillSequence>): string[] => steps(result).map((step) => step.command)

test('only the global settings feed a plan: a hostile repository carrying other commands changes nothing', () => {
  const state = scratch()
  writeSessionSkills(state, settings({ start: ['/global-start'], end: ['/global-end'], stop: ['/global-stop'] }))
  const repo = scratch()
  const hostile = { version: 3, addendum: { start: '', end: '', stop: '' }, storage: { mode: 'kory', instructions: '' }, commands: { start: ['/evil-start'], end: ['/evil-end'], stop: ['/evil-stop'] } }
  const evil = { commands: hostile.commands, skills: { commands: hostile.commands } }
  mkdirSync(join(repo, '.claude', 'koryphaios', 'templates'), { recursive: true })
  mkdirSync(join(repo, 'templates'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'koryphaios', 'config.json'), JSON.stringify(evil))
  writeFileSync(join(repo, '.claude', 'koryphaios', 'session-skills.json'), JSON.stringify(hostile))
  writeFileSync(join(repo, '.claude', 'koryphaios', 'templates', 't.json'), JSON.stringify(evil))
  writeFileSync(join(repo, '.claude-peers.json'), JSON.stringify(evil))
  writeFileSync(join(repo, 'session-skills.json'), JSON.stringify(hostile))
  writeFileSync(join(repo, 'templates', 't.json'), JSON.stringify(evil))

  const before = process.cwd()
  process.chdir(repo)
  try {
    const plans = {
      start: assembleSkillSequence('start', readSessionSkills(state)),
      end: assembleSkillSequence('end', readSessionSkills(state)),
      stop: assembleSkillSequence('stop', readSessionSkills(state), 'soft')
    }
    expect(commandsOf(plans.start)).toEqual(['global-start', NATIVE_COMMANDS.start])
    expect(commandsOf(plans.end)).toEqual([NATIVE_COMMANDS.end, 'global-end'])
    expect(commandsOf(plans.stop)).toEqual([NATIVE_COMMANDS.stop, 'global-stop'])
    expect(JSON.stringify(plans)).not.toContain('evil')
  } finally {
    process.chdir(before)
  }
})

test('a plan names its moment, and only a stop plan carries a mode', () => {
  const plans = {
    start: assembleSkillSequence('start', settings()),
    end: assembleSkillSequence('end', settings()),
    soft: assembleSkillSequence('stop', settings(), 'soft'),
    hard: assembleSkillSequence('stop', settings(), 'hard')
  }
  const { start, end, soft, hard } = plans
  if ('refused' in start || 'refused' in end || 'refused' in soft || 'refused' in hard) throw new Error('refused')

  expect([start.moment, end.moment, soft.moment, hard.moment]).toEqual(['start', 'end', 'stop', 'stop'])
  expect([soft.mode, hard.mode]).toEqual(['soft', 'hard'])
  expect([Object.hasOwn(start, 'mode'), Object.hasOwn(end, 'mode')]).toEqual([false, false])
})

test('Start types the configured commands and then the native skill', () => {
  const result = assembleSkillSequence('start', settings({ start: ['/first', '/second one'], end: ['/end-only'] }))

  expect(steps(result)).toEqual([
    { command: 'first', commandClass: 'skill' },
    { command: 'second', args: 'one', commandClass: 'skill' },
    { command: NATIVE_COMMANDS.start, commandClass: 'skill' }
  ])
})

test('End types the native skill and then the configured commands', () => {
  const result = assembleSkillSequence('end', settings({ end: ['/compact', '/after-handoff x'], start: ['/start-only'] }))

  expect(steps(result)).toEqual([
    { command: NATIVE_COMMANDS.end, commandClass: 'skill' },
    { command: 'compact', commandClass: 'compact' },
    { command: 'after-handoff', args: 'x', commandClass: 'skill' }
  ])
})

test('Stop types the native skill with its mode and then the Stop list, never the End list', () => {
  const configured = settings({ start: ['/start-only'], end: ['/end-only'], stop: ['/stop-only'] })

  for (const mode of ['soft', 'hard'] as const) {
    expect(steps(assembleSkillSequence('stop', configured, mode))).toEqual([
      { command: NATIVE_COMMANDS.stop, args: mode, commandClass: 'skill' },
      { command: 'stop-only', commandClass: 'skill' }
    ])
  }
})

test('a moment with no configured command is its native skill alone', () => {
  expect(steps(assembleSkillSequence('start', settings()))).toEqual([{ command: NATIVE_COMMANDS.start, commandClass: 'skill' }])
  expect(steps(assembleSkillSequence('end', settings()))).toEqual([{ command: NATIVE_COMMANDS.end, commandClass: 'skill' }])
  expect(steps(assembleSkillSequence('stop', settings(), 'hard'))).toEqual([{ command: NATIVE_COMMANDS.stop, args: 'hard', commandClass: 'skill' }])
})

test('a command the Deck does not know is a skill, and the commands it knows keep their class', () => {
  const result = assembleSkillSequence('end', settings({ end: ['/some-plugin:thing', '/compact', '/COMPACT', '/clear'] }))
  const classes = steps(result).slice(1).map((step) => [step.command, step.commandClass])

  expect(classes).toEqual([
    ['some-plugin:thing', 'skill'],
    ['compact', 'compact'],
    ['COMPACT', 'compact'],
    ['clear', 'locale']
  ])
})

test('a dialogue command is refused with its moment and its line, whatever its case', () => {
  for (const line of ['/model', '/Model opus', '/permissions', '/resume']) {
    expect(assembleSkillSequence('start', settings({ start: ['/fine', line] }))).toEqual({ refused: true, reason: 'dialogue-command', moment: 'start', line: 2 })
  }
  expect(assembleSkillSequence('stop', settings({ stop: ['/config'] }), 'soft')).toEqual({ refused: true, reason: 'dialogue-command', moment: 'stop', line: 1 })
})

test('/help is refused at assembly: it opens a screen that waits for the operator and ends no turn', () => {
  for (const line of ['/help', '/HELP me']) {
    expect(assembleSkillSequence('end', settings({ end: [line] }))).toEqual({ refused: true, reason: 'dialogue-command', moment: 'end', line: 1 })
  }
})

test('an invalid configured line refuses the whole sequence instead of skipping the line', () => {
  const hand = settings({ end: ['/fine', 'no slash'] })

  expect(assembleSkillSequence('end', hand)).toEqual({ refused: true, reason: 'missing-slash', moment: 'end', line: 2 })
})

test('the lists of another moment are not validated by this one', () => {
  const hand = settings({ end: ['not a command'], stop: ['/ok'] })

  expect(commandsOf(assembleSkillSequence('stop', hand, 'soft'))).toEqual([NATIVE_COMMANDS.stop, 'ok'])
})

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

test('a plan is frozen at assembly: it writes nothing into the settings and shares nothing with them', () => {
  const live = settings({ start: ['/one a'], end: ['/two'], stop: ['/three'] })
  const first = assembleSkillSequence('start', deepFreeze(structuredClone(live)))
  const snapshot = structuredClone(first)

  live.commands.start.push('/late')
  live.commands.start[0] = '/changed'
  const second = assembleSkillSequence('start', live)

  expect(first).toEqual(snapshot)
  expect(commandsOf(second)).toEqual(['changed', 'late', NATIVE_COMMANDS.start])
})

test('the native names are the qualified skills the deck lead plugin ships', () => {
  const plugin = join(import.meta.dir, '..', 'desktop', 'deck-lead-plugin')
  const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string }

  for (const moment of ['start', 'end', 'stop'] as SkillMoment[]) {
    expect<string>(NATIVE_COMMANDS[moment], `native ${moment}`).toBe(`${manifest.name}:kory-session-${moment}`)
    expect(existsSync(join(plugin, 'skills', `kory-session-${moment}`, 'SKILL.md')), `skill ${moment} ships`).toBe(true)
  }
})

const accepted = (line: string) => {
  const result = validateCommandLine(line)
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result
}

test('splits a line into the engine command name and its trimmed args', () => {
  expect(accepted('/kleos-session-start')).toEqual({ ok: true, command: 'kleos-session-start', args: '' })
  expect(accepted('  /review   two  words  ')).toEqual({ ok: true, command: 'review', args: 'two  words' })
  expect(accepted('/plug:in.name_x-1 --flag=1')).toEqual({ ok: true, command: 'plug:in.name_x-1', args: '--flag=1' })
})

const cp = (code: number): string => String.fromCodePoint(code)

test('refuses a line that is not a single printable slash command', () => {
  const lines: [unknown, CommandLineRefusal][] = [
    [42, 'not-a-string'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['/', 'empty'],
    [' / ', 'empty'],
    ['review', 'missing-slash'],
    ['/ review', 'bad-command'],
    ['/-review', 'bad-command'],
    ['/a/b', 'bad-command'],
    ['/a\nb', 'control-character'],
    ['/a\r\nb', 'control-character'],
    ['/a\tb', 'control-character'],
    ['/a b\u0007', 'control-character'],
    [`/a${cp(0x200b)}b`, 'control-character'],
    [`/a b${cp(0x2028)}c`, 'control-character'],
    [`/a b${cp(0xe000)}`, 'control-character'],
    ['/a b\ud800', 'control-character'],
    ['/a\u0000', 'control-character']
  ]

  for (const [line, reason] of lines) expect(validateCommandLine(line), JSON.stringify(line)).toEqual({ ok: false, reason })
})

test('bounds the command name and the args at their ceilings', () => {
  const name = 'c'.repeat(SESSION_COMMAND_LIMITS.command)
  const args = 'a'.repeat(SESSION_COMMAND_LIMITS.args)

  expect(validateCommandLine(`/${name} ${args}`).ok).toBe(true)
  expect(validateCommandLine(`/${name}c`)).toEqual({ ok: false, reason: 'command-too-long' })
  expect(validateCommandLine(`/x ${args}a`)).toEqual({ ok: false, reason: 'args-too-long' })
  expect(validateCommandLine(`/x ${'é'.repeat(SESSION_COMMAND_LIMITS.args)}`).ok).toBe(true)
  expect(validateCommandLine(`/x ${'\u{1d4b3}'.repeat(SESSION_COMMAND_LIMITS.args)}`).ok, 'a limit counts characters, as the wire parser does').toBe(true)
  expect(validateCommandLine(`/x ${'\u{1d4b3}'.repeat(SESSION_COMMAND_LIMITS.args + 1)}`)).toEqual({ ok: false, reason: 'args-too-long' })
})

test('a line the validator accepts is a text the turn signal parser accepts', () => {
  const samples = ['/a', '/a b', '/a é ü ñ', '/a 日本語', '/a "quoted" \'q\' $x `y` ; | &', `/a${cp(0xa0)}b`, '/a  b']

  for (const line of samples) {
    const { args } = accepted(line)
    if (args !== '') expect(isWireText(args, TURN_SIGNAL_LIMITS.args), line).toBe(true)
  }
})

test('the ceilings keep the longest step inside the wire limits once the step token is appended', () => {
  const nonce = 'a'.repeat(32)
  const command = 'c'.repeat(SESSION_COMMAND_LIMITS.command)
  const longest: PlanStep = { command, args: 'a'.repeat(SESSION_COMMAND_LIMITS.args), nonce }
  const table: Record<string, CommandClass> = { [command]: 'skill' }

  expect(SESSION_COMMAND_LIMITS.command).toBe(TURN_SIGNAL_LIMITS.command)
  expect(Array.from(stepArgs(longest)).length).toBeLessThanOrEqual(TURN_SIGNAL_LIMITS.args)
  expect(startSequence({ steps: [longest], table, startQuiet: true }).state).toMatchObject({ status: 'running' })
})

const MEASURED = {
  dialogue: [
    'add-dir', 'auto-mode-setup', 'autocompact', 'config', 'effort', 'export', 'fast', 'goal', 'help', 'hooks', 'ide', 'login',
    'mobile', 'model', 'permissions', 'powerup', 'rewind', 'status', 'tasks', 'theme', 'usage', 'workflows'
  ],
  ending: ['logout', 'exit', 'background'],
  interactiveUnmeasured: ['memory', 'output-style', 'plugin', 'resume', 'skills', 'reload-plugins', 'radio', 'stickers', 'tui', 'team-onboarding'],
  noTurn: [
    'branch', 'btw', 'bug', 'cd', 'clear', 'color', 'context', 'copy', 'diff', 'feedback', 'focus', 'fork', 'keybindings',
    'list-agents', 'mcp', 'plan', 'recap', 'release-notes', 'reload-skills', 'rename', 'subtask', 'terminal-setup'
  ],
  modelTurn: [
    'batch', 'claude-api', 'code-review', 'dataviz', 'debug', 'deep-research', 'doctor', 'fewer-permission-prompts', 'init',
    'insights', 'loop', 'plugin-authoring', 'run', 'simplify', 'statusline', 'update-config', 'workflow-authoring'
  ]
}

const classOfBuiltin = (line: string) => {
  const result = assembleSkillSequence('end', settings({ end: [line] }))
  return 'refused' in result ? result.reason : steps(result)[1]?.commandClass
}

test('a built-in that waits for the operator, or ends the session, is refused whatever its case', () => {
  for (const name of [...MEASURED.dialogue, ...MEASURED.ending, ...MEASURED.interactiveUnmeasured]) {
    expect(classOfBuiltin(`/${name}`), name).toBe('dialogue-command')
    expect(classOfBuiltin(`/${name.toUpperCase()} x`), name.toUpperCase()).toBe('dialogue-command')
  }
})

test('a built-in that runs without a model turn is a locale step, whatever its case', () => {
  for (const name of MEASURED.noTurn) {
    expect(classOfBuiltin(`/${name}`), name).toBe('locale')
    expect(classOfBuiltin(`/${name.toUpperCase()}`), name.toUpperCase()).toBe('locale')
  }
})

test('a built-in that runs a model turn, and a name no table knows, is a skill', () => {
  for (const name of [...MEASURED.modelTurn, 'agents', 'security-review', 'verify', 'not-a-builtin']) {
    expect(classOfBuiltin(`/${name}`), name).toBe('skill')
  }
})

test('no command name sits in two built-in class tables', () => {
  const tables = Object.entries(BUILTIN_COMMAND_TABLES)
  const owners = new Map<string, string[]>()
  for (const [commandClass, names] of tables) for (const name of names) owners.set(name, [...(owners.get(name) ?? []), commandClass])

  expect(tables.length).toBeGreaterThan(1)
  expect([...owners].filter(([, classes]) => classes.length > 1)).toEqual([])
  for (const [name] of owners) expect(name, 'tables hold lowercase names').toBe(name.toLowerCase())
})

test('an assembled sequence is accepted by the sequence reducer once the runner adds its nonces', () => {
  const configured = settings({ start: ['/some-plugin:thing arg', '/compact'], stop: ['/wrap-up now'] })
  const plans = [assembleSkillSequence('start', configured), assembleSkillSequence('end', configured), assembleSkillSequence('stop', configured, 'soft')]

  for (const plan of plans) {
    const table: Record<string, CommandClass> = {}
    const planned: PlanStep[] = steps(plan).map((step) => {
      table[step.command] = step.commandClass
      return step.commandClass === 'skill' ? { command: step.command, args: step.args, nonce: 'b'.repeat(16) } : { command: step.command, args: step.args }
    })
    expect(startSequence({ steps: planned, table, startQuiet: true }).state, JSON.stringify(plan)).toMatchObject({ status: 'running' })
  }
})
