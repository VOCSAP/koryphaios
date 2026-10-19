// Detail text of the native dialogs that ask the operator to trust a command
// (serve.json, project launch command, worktree hook, shell fields). The
// operator approves exactly what the dialog shows, so every approved field is
// shown in full, cut into numbered lines no wider than the box; when that does
// not fit the work area, the dialog offers no Approve button at all.
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

/** Characters of running text assumed per line when reserving room for the sentences around the fields. */
const TEXT_COLUMNS = 60

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

export interface ApprovalField {
  /** Header line of the block; an empty label prints no header. */
  label: string
  items: readonly string[]
}

export interface ApprovalFieldsRender {
  lines: string[]
  detail: string
  fits: boolean
}

export function renderApprovalFields(
  fields: readonly ApprovalField[],
  opts: { isFr: boolean; maxLines: number; columns?: number }
): ApprovalFieldsRender {
  const columns = opts.columns ?? SERVE_DIALOG_COLUMNS
  const values: string[] = []
  const lines: string[] = []
  for (const { label, items } of fields) {
    if (label) lines.push(label)
    if (items.length === 0) {
      lines.push('    -')
      continue
    }
    for (const item of items) {
      segments(item, columns).forEach((segment, index) => {
        values.push(segment)
        lines.push(`${String(values.length).padStart(2, '0')}${index === 0 ? '|' : '+'} ${segment}`)
      })
    }
  }
  lines.push(opts.isFr ? `Les espaces sont affichés ${MIDDLE_DOT}.` : `Spaces are shown as ${MIDDLE_DOT}.`)
  return { lines, detail: lines.join('\n'), fits: lines.length <= opts.maxLines }
}

export interface ApprovalDialogSpec {
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  /** Index of the button that approves, null when the text does not fit and nothing may be approved. */
  approveIndex: number | null
  /** Index of the button that shows the source file in the file manager, null when Approve is offered or there is no file. */
  showFileIndex: number | null
}

export interface ApprovalDialogText {
  message: string
  /** Sentence printed above the fields. */
  lead?: string
  /** Sentence printed below the fields. */
  trail?: string
  approve: string
  refuse: string
  close: string
  /** Detail shown instead of the fields when they do not fit. */
  tooLong: string
  /** Label of the button that shows the source file; omitted when there is none. */
  showFile?: string
}

/** Refuse is both the default and the cancel answer; a body that does not fit offers no way to approve. */
export function approvalDialogSpec(render: ApprovalFieldsRender, text: ApprovalDialogText): ApprovalDialogSpec {
  if (!render.fits) {
    const buttons = text.showFile === undefined ? [text.close] : [text.showFile, text.close]
    return {
      message: text.message,
      detail: text.tooLong,
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
      approveIndex: null,
      showFileIndex: text.showFile === undefined ? null : 0
    }
  }
  return {
    message: text.message,
    detail: [text.lead, render.detail, text.trail].filter(Boolean).join('\n\n'),
    buttons: [text.approve, text.refuse],
    defaultId: 1,
    cancelId: 1,
    approveIndex: 0,
    showFileIndex: null
  }
}

/** Whether the button the operator pressed approves; a spec with no Approve button never does. */
export function isApprovalAnswer(spec: Pick<ApprovalDialogSpec, 'approveIndex'>, response: number): boolean {
  return spec.approveIndex !== null && response === spec.approveIndex
}

export interface ServeApprovalRender extends ApprovalFieldsRender {
  commandLength: number
}

const commandLabel = (commandLength: number, isFr: boolean): string =>
  isFr ? `commande (${commandLength} caractères) :` : `command (${commandLength} characters):`

export function serveDialogSpec(render: ServeApprovalRender, isFr: boolean): ApprovalDialogSpec {
  return approvalDialogSpec(render, {
    message: isFr ? 'Ce projet définit un serveur de dev (serve.json).' : 'This project defines a dev server (serve.json).',
    approve: isFr ? 'Lancer ce serveur' : 'Run this server',
    refuse: isFr ? 'Refuser' : 'Refuse',
    close: isFr ? 'Fermer' : 'Close',
    showFile: isFr ? 'Montrer serve.json' : 'Show serve.json',
    tooLong: isFr
      ? `Sa commande et son environnement (${render.lines.length} lignes) dépassent ce que cette fenêtre montre en entier, donc il ne peut pas être approuvé ici. Raccourcis serve.json, puis relance.`
      : `Its command and environment (${render.lines.length} lines) exceed what this window shows in full, so it cannot be approved here. Shorten serve.json, then start again.`
  })
}

export function renderServeApproval(
  prompt: ServeApprovalPrompt,
  opts: { isFr: boolean; maxLines: number; columns?: number }
): ServeApprovalRender {
  const commandLength = Array.from(prompt.command).length
  const render = renderApprovalFields(
    [
      { label: commandLabel(commandLength, opts.isFr), items: [prompt.command] },
      { label: opts.isFr ? 'dossier :' : 'directory:', items: [prompt.cwd] },
      { label: 'port:', items: [String(prompt.port)] },
      { label: 'env:', items: Object.entries(prompt.env).map(([name, value]) => `${name}=${value}`) },
      { label: 'inheritEnv:', items: prompt.inheritEnv }
    ],
    opts
  )
  return { ...render, commandLength }
}

export interface GateDialogOpts {
  isFr: boolean
  maxLines: number
}

export interface GateDialogInput extends GateDialogOpts {
  message: string
  lead: string
  fields: readonly ApprovalField[]
  trail: string
  buttons: readonly [approve: string, refuse: string]
}

/** Lines a sentence takes in the box, assuming TEXT_COLUMNS narrow characters per line; a wide character takes more room, so this is an estimate, not a bound. */
function textLines(text: string): number {
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / TEXT_COLUMNS)), 0)
}

/** The sentences around the fields take lines from the budget, so the fields are never the part clipped. */
export function gateDialog(input: GateDialogInput): ApprovalDialogSpec {
  const { isFr } = input
  const reserved = textLines(input.lead) + textLines(input.trail) + 2
  const render = renderApprovalFields(input.fields, { isFr, maxLines: input.maxLines - reserved })
  return approvalDialogSpec(render, {
    message: input.message,
    lead: input.lead,
    trail: input.trail,
    approve: input.buttons[0],
    refuse: input.buttons[1],
    close: isFr ? 'Fermer' : 'Close',
    tooLong: isFr
      ? `Son contenu (${render.lines.length} lignes) dépasse ce que cette fenêtre montre en entier, donc il ne peut pas être approuvé ici. Raccourcis-le, puis relance.`
      : `Its content (${render.lines.length} lines) exceeds what this window shows in full, so it cannot be approved here. Shorten it, then start again.`
  })
}

export function launchCommandDialog(command: string, opts: GateDialogOpts): ApprovalDialogSpec {
  const { isFr } = opts
  return gateDialog({
    ...opts,
    message: isFr
      ? 'Ce projet définit sa propre commande de lancement des sessions.'
      : 'This project defines its own session launch command.',
    lead: isFr ? 'Commande (config du projet) :' : 'Command (project config):',
    fields: [{ label: commandLabel(Array.from(command).length, isFr), items: [command] }],
    trail: isFr
      ? "Elle sera exécutée dans chaque terminal de session de ce projet. N'accepte que si tu fais confiance à ce dépôt. Refuser garde la commande globale."
      : 'It will run in every session terminal of this project. Accept only if you trust this repository. Refusing keeps the global command.',
    buttons: isFr ? ['Utiliser cette commande', 'Refuser'] : ['Use this command', 'Refuse']
  })
}

export function worktreeInitDialog(command: string, opts: GateDialogOpts): ApprovalDialogSpec {
  const { isFr } = opts
  return gateDialog({
    ...opts,
    message: isFr
      ? 'Ce projet définit un hook exécuté à la création de worktree.'
      : 'This project defines a worktree-creation init hook.',
    lead: isFr ? 'Hook (config du projet) :' : 'Hook (project config):',
    fields: [{ label: commandLabel(Array.from(command).length, isFr), items: [command] }],
    trail: isFr
      ? "Il sera exécuté dans un shell à chaque création de worktree de ce projet. N'accepte que si tu fais confiance à ce dépôt. Refuser désactive ce hook."
      : 'It will run in a shell on every worktree creation for this project. Accept only if you trust this repository. Refusing disables the hook.',
    buttons: isFr ? ['Exécuter ce hook', 'Refuser'] : ['Run this hook', 'Refuse']
  })
}

export function shellFieldDialog(
  input: GateDialogOpts & {
    message: string
    label: string
    basename: string
    items: readonly string[]
    buttons: readonly [approve: string, refuse: string]
  }
): ApprovalDialogSpec {
  const { label, basename, items, ...rest } = input
  return gateDialog({
    ...rest,
    lead: '',
    fields: [
      { label: `${label}${input.isFr ? ' :' : ':'}`, items: [basename] },
      { label: '', items }
    ],
    trail: input.isFr ? 'Accepte uniquement si tu fais confiance à ce dépôt.' : 'Accept only if you trust this repository.'
  })
}
