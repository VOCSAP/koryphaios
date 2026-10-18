import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('uses the Electron-compatible CJS default bridge for headless xterm', async () => {
  const source = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'xterm-screen.ts'), 'utf8')
  expect(source).toMatch(/^import headless from '@xterm\/headless'$/m)

  const directory = mkdtempSync(join(tmpdir(), 'kory-xterm-cjs-'))
  const script = join(directory, 'probe.mjs')
  const packageMain = pathToFileURL(
    join(import.meta.dir, '..', 'desktop', 'node_modules', '@xterm', 'headless', 'lib-headless', 'xterm-headless.js')
  ).href
  writeFileSync(
    script,
    `import headless from ${JSON.stringify(packageMain)}\nconst terminal = new headless.Terminal({ cols: 2, rows: 1 })\nterminal.dispose()\nprocess.stdout.write('default-bridge')\n`
  )
  const electron = createRequire(import.meta.url)(join(import.meta.dir, '..', 'desktop', 'node_modules', 'electron')) as string
  const child = Bun.spawn([electron, script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  rmSync(directory, { recursive: true, force: true })

  expect(code, stderr).toBe(0)
  expect(stdout).toBe('default-bridge')
})
