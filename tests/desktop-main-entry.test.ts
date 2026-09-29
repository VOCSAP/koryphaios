import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const desktop = join(import.meta.dir, '..', 'desktop')

async function mainInputs(): Promise<Record<string, string>> {
  const config = (await import('../desktop/electron.vite.config.ts')).default as {
    main: { build: { rollupOptions: { input: Record<string, string> } } }
  }
  return config.main.build.rollupOptions.input
}

test('package.json main names the router file emitted by the main rollup inputs', async () => {
  const inputs = await mainInputs()
  const main = (JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf-8')) as { main: string }).main
  const emitted = Object.keys(inputs).map((name) => `out/main/${name}.js`)
  expect(emitted).toContain(main)
  expect(resolve(inputs.entry!)).toBe(resolve(desktop, 'src', 'main', 'entry.ts'))
  expect(main).toBe('out/main/entry.js')
})

test('the Deck and the Avatar stay named main inputs the router can load', async () => {
  const inputs = await mainInputs()
  expect(resolve(inputs.index!)).toBe(resolve(desktop, 'src', 'main', 'index.ts'))
  expect(resolve(inputs['avatar-entry']!)).toBe(resolve(desktop, 'src', 'main', 'avatar-entry.ts'))
})

test('source scan: the router has no static import, so nothing runs before it chooses', () => {
  const source = readFileSync(join(desktop, 'src', 'main', 'entry.ts'), 'utf-8')
  expect(source).not.toMatch(/^\s*import\s/m)
  expect(source).not.toMatch(/\brequire\s*\(/)
  expect(source).toContain("process.argv.includes('--avatar') ? import('./avatar-entry') : import('./index')")
})
