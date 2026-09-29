import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scrubEnv } from './_scrub-env.ts'

test('Electron carries attach, bind, bound, focus command and result over the real TLS WebSocket', async () => {
  const repo = join(import.meta.dir, '..')
  const bundleDir = mkdtempSync(join(tmpdir(), 'kory-avatar-wss-'))
  const require = createRequire(import.meta.url)
  const electron = require(join(repo, 'desktop', 'node_modules', 'electron')) as string
  const sources = [
    join(repo, 'desktop', 'src', 'main', 'avatar-server.ts'),
    join(repo, 'desktop', 'src', 'main', 'avatar-client.ts'),
    join(repo, 'desktop', 'src', 'main', 'avatar-transport.ts'),
    join(repo, 'desktop', 'src', 'main', 'avatar-certificate.ts'),
    join(repo, 'desktop', 'src', 'shared', 'avatar-state.ts')
  ]

  try {
    const bundles = sources.map((source, index) => {
      const output = join(bundleDir, `bundle-${index}.cjs`)
      const build = Bun.spawnSync([process.execPath, 'build', '--target=node', '--format=cjs', `--outfile=${output}`, source], {
        env: scrubEnv(bundleDir)
      })
      expect(build.exitCode).toBe(0)
      return output
    })

    const child = Bun.spawn([electron, join(import.meta.dir, 'fixtures', 'avatar-wss-electron.cjs'), ...bundles], {
      env: scrubEnv(bundleDir, { ELECTRON_RUN_AS_NODE: '1' }),
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      unattachedBindCloseCode: 4403,
      upgrades: { wrongRoute: 'destroyed', withOrigin: 'destroyed', wrongBearer: 'destroyed' },
      oversizedCloseCode: 1009,
      detachCloseCode: 4410,
      focusOk: true,
      focused: 1,
      attachedBeforeStop: 1,
      attachedAfterStop: 0,
      reports: [
        'avatar-server: rejected Avatar WebSocket bind for an unattached Deck',
        'avatar-server: rejected Avatar WebSocket request for an unknown route',
        'avatar-server: rejected Avatar WebSocket request with an Origin header',
        'avatar-server: rejected unauthorized Avatar WebSocket request',
        'avatar-server: Avatar WebSocket error'
      ]
    })
  } finally {
    rmSync(bundleDir, { recursive: true, force: true })
  }
}, 30_000)
