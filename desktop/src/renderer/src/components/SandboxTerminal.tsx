import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useDeck } from '../store'

// Dialog-hosted xterm bound to one of the sandbox UTILITY PTYs (the login
// terminal and the image build, PLAN-SANDBOX SBX3/M2). Follows the
// DockTerminal precedent from BrowserView: no registry registration (these
// ids are not sessions, so cross-session search must not see them) and no
// tile chrome. Utility PTYs travel over the SAME pty:* channels as sessions,
// so nothing had to be added to the bridge.

const THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    selectionBackground: '#264f78'
  },
  light: {
    background: '#ffffff',
    foreground: '#1f1f1f',
    cursor: '#1f1f1f',
    selectionBackground: '#add6ff'
  }
}

const FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

export function SandboxTerminal({
  ptyId,
  onExit
}: {
  ptyId: string
  /** Utility process exited (build finished, login terminal closed). */
  onExit?: (exitCode: number) => void
}): React.JSX.Element {
  const config = useDeck((s) => s.config!)
  const hostRef = useRef<HTMLDivElement>(null)
  // Kept in a ref so a re-render never re-subscribes the PTY listeners.
  const exitRef = useRef(onExit)
  exitRef.current = onExit

  useEffect(() => {
    const term = new Terminal({
      fontSize: config.fontSize,
      fontFamily: FONT_STACK,
      cursorBlink: true,
      scrollback: 4000,
      theme: THEMES[config.theme]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    if (hostRef.current) term.open(hostRef.current)

    const onInput = term.onData((d) => window.api.ptyInput(ptyId, d))
    const offData = window.api.onPtyData((e) => {
      if (e.id === ptyId) term.write(e.data)
    })
    const offExit = window.api.onPtyExit((e) => {
      if (e.id !== ptyId) return
      term.write('\r\n\x1b[2m[terminal closed]\x1b[0m\r\n')
      exitRef.current?.(e.exitCode)
    })

    const doFit = (): void => {
      const host = hostRef.current
      if (!host || host.clientWidth < 4 || host.clientHeight < 4) return
      try {
        fit.fit()
        window.api.ptyResize(ptyId, term.cols, term.rows)
      } catch {
        /* terminal mid-teardown */
      }
    }
    const raf = requestAnimationFrame(doFit)
    const observer = new ResizeObserver(doFit)
    if (hostRef.current) observer.observe(hostRef.current)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      onInput.dispose()
      offData()
      offExit()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId])

  return <div ref={hostRef} className="sandbox-auth-term" />
}
