// Detail text of the native serve.json approval dialog. The operator approves
// exactly what the dialog shows, so every approved field is shown in full,
// cut into numbered lines no wider than the box; when that does not fit the
// work area, the dialog offers no Approve button at all.
//
// Pure module, no electron: unit-tested under bun.

import type { ServeApprovalPrompt } from './serve-config'

/**
 * Characters per value line; every line is one unbreakable word for the box.
 * Native box capped at 556 px; 40 W fit with 11 px to spare, 36 leaves room for another font.
 */
export const SERVE_DIALOG_COLUMNS = 36
export const SERVE_DIALOG_MAX_LINES = 40

/** Measured on the Windows TaskDialog at 96 dpi: about 15 logical px per line, 140 px of buttons and frame. */
const LINE_PX = 15
const CHROME_PX = 140

const MIDDLE_DOT = String.fromCharCode(0xb7)

/** Lines that fit the display work area (logical px) without scrolling; 0 when the height is unusable. */
export function maxLinesFor(workAreaHeight: number): number {
  if (!Number.isFinite(workAreaHeight)) return 0
  return Math.max(0, Math.min(SERVE_DIALOG_MAX_LINES, Math.floor((workAreaHeight - CHROME_PX) / LINE_PX)))
}

/**
 * Display units of a value: the ASCII space is a middle dot so padding stays
 * visible, printable ASCII is itself, and every other code point is an atomic
 * {U+XXXX} unit, so no wide, stacked, blank or look-alike character reaches
 * the box and the width of a line depends on ASCII glyphs only.
 */
function units(text: string): string[] {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0)!
    if (code === 0x20) return MIDDLE_DOT
    if (code > 0x20 && code < 0x7f) return char
    return `{U+${code.toString(16).toUpperCase().padStart(4, '0')}}`
  })
}

/** Packs units into lines of at most `columns` characters, never splitting an escape. */
function segments(text: string, columns: number): string[] {
  const out: string[] = []
  let line = ''
  for (const unit of units(text)) {
    if (line.length > 0 && line.length + unit.length > columns) {
      out.push(line)
      line = ''
    }
    line += unit
  }
  out.push(line)
  return out
}

export interface ServeApprovalRender {
  lines: string[]
  detail: string
  fits: boolean
  commandLength: number
}

export interface ServeDialogSpec {
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  /** Index of the button that approves, null when the text does not fit and nothing may be approved. */
  approveIndex: number | null
  /** Index of the button that shows serve.json in the file manager, null when Approve is offered. */
  showFileIndex: number | null
}

/** Refuse is both the default and the cancel answer; a body that does not fit offers no way to approve. */
export function serveDialogSpec(render: ServeApprovalRender, isFr: boolean): ServeDialogSpec {
  const message = isFr ? 'Ce projet définit un serveur de dev (serve.json).' : 'This project defines a dev server (serve.json).'
  if (!render.fits) {
    return {
      message,
      detail: isFr
        ? `Sa commande et son environnement (${render.lines.length} lignes) dépassent ce que cette fenêtre montre en entier, donc il ne peut pas être approuvé ici. Raccourcis serve.json, puis relance.`
        : `Its command and environment (${render.lines.length} lines) exceed what this window shows in full, so it cannot be approved here. Shorten serve.json, then start again.`,
      buttons: isFr ? ['Montrer serve.json', 'Fermer'] : ['Show serve.json', 'Close'],
      defaultId: 1,
      cancelId: 1,
      approveIndex: null,
      showFileIndex: 0
    }
  }
  return {
    message,
    detail: render.detail,
    buttons: isFr ? ['Lancer ce serveur', 'Refuser'] : ['Run this server', 'Refuse'],
    defaultId: 1,
    cancelId: 1,
    approveIndex: 0,
    showFileIndex: null
  }
}

export function renderServeApproval(
  prompt: ServeApprovalPrompt,
  opts: { isFr: boolean; maxLines: number; columns?: number }
): ServeApprovalRender {
  const columns = opts.columns ?? SERVE_DIALOG_COLUMNS
  const commandLength = Array.from(prompt.command).length
  const values: string[] = []
  const lines: string[] = []
  const field = (label: string, items: readonly string[]): void => {
    lines.push(label)
    if (items.length === 0) {
      lines.push('    -')
      return
    }
    for (const item of items) {
      segments(item, columns).forEach((segment, index) => {
        values.push(segment)
        lines.push(`${String(values.length).padStart(2, '0')}${index === 0 ? '|' : '+'} ${segment}`)
      })
    }
  }
  field(opts.isFr ? `commande (${commandLength} caractères) :` : `command (${commandLength} characters):`, [prompt.command])
  field(opts.isFr ? 'dossier :' : 'directory:', [prompt.cwd])
  field('port:', [String(prompt.port)])
  field('env:', Object.entries(prompt.env).map(([name, value]) => `${name}=${value}`))
  field('inheritEnv:', prompt.inheritEnv)
  lines.push(opts.isFr ? `Les espaces sont affichés ${MIDDLE_DOT}.` : `Spaces are shown as ${MIDDLE_DOT}.`)
  return { lines, detail: lines.join('\n'), fits: lines.length <= opts.maxLines, commandLength }
}
