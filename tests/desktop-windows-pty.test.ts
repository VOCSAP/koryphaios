import { describe, expect, test } from 'bun:test'
import { windowsPtyFor } from '../desktop/src/shared/windows-pty'

describe('windowsPtyFor', () => {
  test('off Windows there is no host PTY backend to emulate', () => {
    expect(windowsPtyFor('darwin', '25.0.0')).toBeNull()
    expect(windowsPtyFor('linux', '10.0.26300')).toBeNull()
  })

  test('a Windows build at or above the node-pty threshold is ConPTY with its build number', () => {
    expect(windowsPtyFor('win32', '10.0.26300')).toEqual({ backend: 'conpty', buildNumber: 26300 })
    expect(windowsPtyFor('win32', '10.0.18309')).toEqual({ backend: 'conpty', buildNumber: 18309 })
  })

  test('a Windows build below the threshold is winpty', () => {
    expect(windowsPtyFor('win32', '10.0.17763')).toEqual({ backend: 'winpty', buildNumber: 17763 })
    expect(windowsPtyFor('win32', '10.0.18308')).toEqual({ backend: 'winpty', buildNumber: 18308 })
  })

  test.each(['', 'abc', '10.0', '10.0.', '10.0.abc', '10.0.-5', '10.0.0', '10.0.1e3', '10.0.99999999999999999999'])(
    'an unparseable release %p defaults to ConPTY without a build number',
    (release) => {
      const info = windowsPtyFor('win32', release)
      expect(info).toEqual({ backend: 'conpty' })
      expect(info).not.toHaveProperty('buildNumber')
    }
  )
})
