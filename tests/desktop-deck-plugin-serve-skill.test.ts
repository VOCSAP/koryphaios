import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDeckLog } from '../desktop/src/main/log.ts'
import { maxLinesFor, renderServeApproval } from '../desktop/src/main/serve-approval-dialog.ts'
import { readServeConfig } from '../desktop/src/main/serve-config.ts'

const SKILL = readFileSync(join(import.meta.dir, '..', 'desktop', 'deck-plugin', 'skills', 'project-serve', 'SKILL.md'), 'utf8')
const MARKER = /^<!-- serve-example: (valid|refused) ([\w.]+) -->$/
const FRAMEWORKS = ['vite', 'next', 'django', 'http.server', 'rails']

interface Example {
  verdict: 'valid' | 'refused'
  label: string
  json: string
}

/** Every ```json block with the marker line right above it; a block without a marker, or a marker without a block, is an error. */
function examples(markdown: string): Example[] {
  const lines = markdown.split(/\r?\n/)
  const found: Example[] = []
  for (let index = 0; index < lines.length; index++) {
    const marker = MARKER.exec(lines[index]!.trim())
    if (lines[index]!.trim() === '```json') {
      const above = MARKER.exec(lines[index - 1]?.trim() ?? '')
      if (!above) throw new Error(`json block at line ${index + 1} has no serve-example marker`)
      const end = lines.indexOf('```', index + 1)
      found.push({ verdict: above[1] as Example['verdict'], label: above[2]!, json: lines.slice(index + 1, end).join('\n') })
    } else if (marker && lines[index + 1]?.trim() !== '```json') {
      throw new Error(`serve-example marker at line ${index + 1} is not followed by a json block`)
    }
  }
  return found
}

const logsDir = mkdtempSync(join(tmpdir(), 'cp-serve-skill-logs-'))
const projects: string[] = []
beforeAll(() => initDeckLog(logsDir))
afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true })
})
afterAll(() => rmSync(logsDir, { recursive: true, force: true }))

/** A project holding the example as its serve.json, with every directory the example names. */
function projectFor(json: string): string {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-serve-skill-')))
  projects.push(project)
  mkdirSync(join(project, '.claude', 'claude-peers'), { recursive: true })
  const parsed = JSON.parse(json) as { actions?: Array<{ cwd?: unknown }> }
  for (const action of parsed.actions ?? []) {
    if (typeof action.cwd === 'string' && !action.cwd.startsWith('/') && !action.cwd.includes(':')) {
      mkdirSync(join(project, action.cwd), { recursive: true })
    }
  }
  writeFileSync(join(project, '.claude', 'claude-peers', 'serve.json'), json, 'utf8')
  return project
}

const all = examples(SKILL)

test('marks every json example of the skill, valid or refused', () => {
  const blocks = SKILL.split(/\r?\n/).filter((line) => line.trim() === '```json').length
  expect(all.length, 'every json block is an example the validator sees').toBe(blocks)
  expect(all.filter((example) => example.verdict === 'valid').map((example) => example.label).sort()).toEqual([...FRAMEWORKS].sort())
  expect(all.filter((example) => example.verdict === 'refused').map((example) => example.label).sort()).toEqual(['actions', 'health'])
})

test('every valid example passes the validator, runs one unchained command on an auto port, and fits a 720 px screen', async () => {
  for (const example of all.filter((candidate) => candidate.verdict === 'valid')) {
    const result = await readServeConfig(projectFor(example.json))
    if ('error' in result) throw new Error(`${example.label}: ${result.error}`)
    const action = result.config.actions[0]
    expect(action.command, `${example.label} runs one command under PowerShell 5.1 too`).not.toMatch(/&&|\|\||;|\||\bcd /)
    expect(action.port, `${example.label} takes a free port`).toBe('auto')
    const render = renderServeApproval(
      { command: action.command, cwd: action.cwd, env: action.env, inheritEnv: action.inheritEnv, port: action.port },
      { isFr: false, maxLines: maxLinesFor(720) }
    )
    expect(render.fits, `${example.label} can be approved in the dialog`).toBe(true)
  }
})

test('every refused example is refused for the field it names', async () => {
  for (const example of all.filter((candidate) => candidate.verdict === 'refused')) {
    const result = await readServeConfig(projectFor(example.json))
    expect('error' in result && result.error.startsWith(`${example.label}:`), `${example.label}: ${JSON.stringify(result)}`).toBe(true)
  }
})

test('the skill guides without an agent, without an emoji, and without naming an unshipped button', () => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(SKILL)?.[1] ?? ''
  expect(frontmatter).toMatch(/^name: project-serve$/m)
  expect(frontmatter).toMatch(/^description: /m)
  expect(frontmatter).not.toMatch(/^agent:/m)
  expect(SKILL.match(/\p{Extended_Pictographic}/gu) ?? []).toEqual([])
  expect(SKILL).not.toMatch(/Serve button/i)
})
