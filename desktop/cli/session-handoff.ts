import { readFileSync } from 'node:fs'
import { createRollingLogger } from '../src/main/log'
import {
  publishSessionHandoff,
  readSessionHandoff,
  readSessionHandoffBinding,
  sessionHandoffSupported
} from '../src/main/session-handoff'

class HandoffCommandError extends Error {
  constructor(message: string, readonly exitCode: 64 | 65 | 66 | 74 | 77) {
    super(message)
  }
}

function usage(): never {
  throw new HandoffCommandError('Invalid session-handoff command', 64)
}

function binding() {
  const file = process.env.KORY_SESSION_HANDOFF_BINDING
  if (!file) throw new HandoffCommandError('Missing session-handoff binding', 77)
  try {
    return readSessionHandoffBinding(file)
  } catch {
    throw new HandoffCommandError('Invalid session-handoff binding', 77)
  }
}

function main(): void {
  if (!sessionHandoffSupported()) throw new HandoffCommandError('Invalid session-handoff binding', 77)
  const [command, ...args] = process.argv.slice(2)
  if (command === 'context' && args.length !== 0) usage()
  if (command === 'read' && (args.length !== 1 || !/^(?:latest|[1-9]\d*)$/.test(args[0] ?? ''))) usage()
  if (command !== 'context' && command !== 'read' && (command !== 'publish' || args.length !== 0)) usage()

  const activeBinding = binding()
  const store = { archiveDir: activeBinding.archiveDir, projectKey: activeBinding.projectKey }
  if (command === 'context') {
    process.stdout.write(`${JSON.stringify({
      project: activeBinding.projectKey,
      draft: activeBinding.draftPath,
      helper: '"$KORY_SESSION_HELPER"',
      addendum: { start: '', end: '', stop: '' }
    })}\n`)
    return
  }
  if (command === 'read') {
    const selector = args[0] === 'latest' ? 'latest' : Number(args[0])
    try {
      const handoff = readSessionHandoff(store, selector)
      process.stdout.write(`${JSON.stringify({ number: handoff.number, markdown: handoff.markdown })}\n`)
    } catch (error) {
      if (error instanceof Error && error.message === 'Handoff not found') {
        throw new HandoffCommandError(error.message, 66)
      }
      throw new HandoffCommandError(error instanceof Error ? error.message : String(error), 74)
    }
    return
  }
  try {
    let markdown: string
    try {
      markdown = readFileSync(activeBinding.draftPath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new HandoffCommandError('Handoff content is empty', 65)
      }
      throw error
    }
    const log = createRollingLogger({ dir: activeBinding.logDir, name: 'session-handoff', mirrorToConsole: false })
    const number = publishSessionHandoff(
      store,
      markdown,
      { author: activeBinding.launchId, now: new Date() },
      (message, error) => log.warn(message, error)
    )
    process.stdout.write(`${JSON.stringify({ number })}\n`)
  } catch (error) {
    if (error instanceof Error && (error.message === 'Handoff content is empty' || error.message === 'Handoff content is too large')) {
      throw new HandoffCommandError(error.message, 65)
    }
    throw new HandoffCommandError(error instanceof Error ? error.message : String(error), 74)
  }
}

try {
  main()
} catch (error) {
  const commandError = error instanceof HandoffCommandError ? error : new HandoffCommandError(
    error instanceof Error ? error.message : String(error),
    74
  )
  process.stderr.write(`${commandError.message}\n`)
  process.exitCode = commandError.exitCode
}
