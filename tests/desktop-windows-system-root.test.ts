import { expect, test } from 'bun:test'
import { system32Dir } from '../desktop/src/main/windows-system-root.ts'

test('an absolute SystemRoot resolves to its System32 directory, whatever its separators', () => {
  expect(system32Dir('C:\\Windows')).toEqual({ ok: true, dir: 'C:\\Windows\\System32' })
  expect(system32Dir('C:\\Windows\\')).toEqual({ ok: true, dir: 'C:\\Windows\\System32' })
  expect(system32Dir('D:/Win')).toEqual({ ok: true, dir: 'D:\\Win\\System32' })
  expect(system32Dir('C:\\Win..dows'), 'two dots inside a name are not a parent segment').toEqual({
    ok: true,
    dir: 'C:\\Win..dows\\System32'
  })
})

test('a SystemRoot the working directory could complete is refused', () => {
  for (const systemRoot of [undefined, '', 'Windows', 'rel\\dir', '.\\Windows', '\\Windows', '\\\\server\\share']) {
    expect(system32Dir(systemRoot), String(systemRoot)).toEqual({ ok: false, reason: 'not-absolute' })
  }
  for (const systemRoot of ['C:\\Windows\\..\\Evil', 'C:\\..', 'C:/Windows/..', 'C:\\..\\Windows']) {
    expect(system32Dir(systemRoot), systemRoot).toEqual({ ok: false, reason: 'dot-dot' })
  }
})
