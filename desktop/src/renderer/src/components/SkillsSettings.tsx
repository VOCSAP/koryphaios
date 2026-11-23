import { useEffect, useId, useRef, useState } from 'react'
import type { SessionSkillAddendum, SessionSkillCommands, SessionSkillSettings, SessionSkillStorage } from '@shared/types'
import { SESSION_COMMAND_LIMITS, SESSION_SKILL_TEXT_MAX_BYTES, sessionSkillTextBytes } from '../../../shared/session-skill-limits'
import { checkConfiguredLine, type ConfiguredLineResult } from '../../../shared/session-command-line'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { errorText } from '../store'
import { useT } from '../i18n'

type Moment = keyof SessionSkillAddendum

const MOMENTS: { id: Moment; command: string; titleKey: string; helpKey: string; commandsHelpKey: string }[] = [
  { id: 'start', command: '/kory-session-start', titleKey: 'skills.startTitle', helpKey: 'skills.startHelp', commandsHelpKey: 'skills.commandsStartHelp' },
  { id: 'end', command: '/kory-session-end', titleKey: 'skills.endTitle', helpKey: 'skills.endHelp', commandsHelpKey: 'skills.commandsEndHelp' },
  { id: 'stop', command: '/kory-session-stop', titleKey: 'skills.stopTitle', helpKey: 'skills.stopHelp', commandsHelpKey: 'skills.commandsStopHelp' }
]

const EMPTY: SessionSkillAddendum = { start: '', end: '', stop: '' }
const NO_COMMANDS: SessionSkillCommands = { start: [], end: [], stop: [] }

type Refusal = Extract<ConfiguredLineResult, { ok: false }>['reason']
type LineClass = Extract<ConfiguredLineResult, { ok: true }>['commandClass']

const REFUSAL_KEYS: Record<Refusal, string> = {
  'not-a-string': 'skills.refusalBadCommand',
  'control-character': 'skills.refusalControl',
  empty: 'skills.refusalEmpty',
  'missing-slash': 'skills.refusalSlash',
  'bad-command': 'skills.refusalBadCommand',
  'command-too-long': 'skills.refusalCommandLong',
  'args-too-long': 'skills.refusalArgsLong',
  'dialogue-command': 'skills.refusalDialogue'
}

const CLASS_KEYS: Record<LineClass, string> = {
  skill: 'skills.classSkill',
  locale: 'skills.classLocale',
  compact: 'skills.classCompact'
}

// A row keeps its own id: two rows may hold the same text, and focus must follow the row that moves.
type Row = { id: number; text: string }
type DraftCommands = Record<Moment, Row[]>

const blankLine = (text: string): boolean => text.trim() === ''

const cleanCommands = (draft: DraftCommands): SessionSkillCommands => ({
  start: draft.start.map((r) => r.text.trim()).filter((l) => l !== ''),
  end: draft.end.map((r) => r.text.trim()).filter((l) => l !== ''),
  stop: draft.stop.map((r) => r.text.trim()).filter((l) => l !== '')
})

const sameLines = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((l, i) => l === b[i])

const sameCommands = (a: SessionSkillCommands, b: SessionSkillCommands): boolean =>
  sameLines(a.start, b.start) && sameLines(a.end, b.end) && sameLines(a.stop, b.stop)

const dropBlankRows = (draft: DraftCommands): DraftCommands => ({
  start: draft.start.filter((r) => !blankLine(r.text)),
  end: draft.end.filter((r) => !blankLine(r.text)),
  stop: draft.stop.filter((r) => !blankLine(r.text))
})

type Storage = SessionSkillStorage
type StorageMode = Storage['mode']

const KORY_STORAGE: Storage = { mode: 'kory', instructions: '' }

const STORAGE_MODES: { id: StorageMode; labelKey: string; helpKey: string }[] = [
  { id: 'kory', labelKey: 'skills.storageKory', helpKey: 'skills.storageKoryHelp' },
  { id: 'custom', labelKey: 'skills.storageCustom', helpKey: 'skills.storageCustomHelp' }
]

type Load = { kind: 'loading' } | { kind: 'invalid'; message: string } | { kind: 'ready' }
type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

const sameAddendum = (a: SessionSkillAddendum, b: SessionSkillAddendum): boolean =>
  a.start === b.start && a.end === b.end && a.stop === b.stop

const sameStorage = (a: Storage, b: Storage): boolean => a.mode === b.mode && a.instructions === b.instructions

// Main refuses the same cases; checking here keeps Save disabled with a reason instead of a round trip.
const blankCustom = (s: Storage): boolean => s.mode === 'custom' && s.instructions.trim() === ''
const tooLarge = (text: string): boolean => sessionSkillTextBytes(text) > SESSION_SKILL_TEXT_MAX_BYTES

function StorageField({
  value,
  onChange
}: {
  value: Storage
  onChange: (next: Storage) => void
}): React.JSX.Element {
  const t = useT()
  const titleId = useId()
  const labelId = useId()
  const radioName = useId()
  return (
    <section className="skills-moment" aria-labelledby={titleId}>
      <header className="skills-moment-head">
        <h3 id={titleId}>{t('skills.storageTitle')}</h3>
      </header>
      <p className="skills-moment-help">{t('skills.storageHelp')}</p>
      <div role="radiogroup" aria-labelledby={titleId}>
        {STORAGE_MODES.map((m) => (
          <div key={m.id}>
            <label className="field field-check">
              <input
                type="radio"
                name={radioName}
                value={m.id}
                checked={value.mode === m.id}
                onChange={() => onChange({ ...value, mode: m.id })}
              />
              <span>{t(m.labelKey)}</span>
            </label>
            <small className="field-check-help">{t(m.helpKey)}</small>
          </div>
        ))}
      </div>
      {value.mode === 'custom' ? (
        <>
          <label className="field skills-field">
            <span id={labelId}>{t('skills.storageLabel')}</span>
            <textarea
              aria-labelledby={`${titleId} ${labelId}`}
              aria-invalid={blankCustom(value) || tooLarge(value.instructions) || undefined}
              value={value.instructions}
              rows={6}
              spellCheck={false}
              placeholder={t('skills.storagePlaceholder')}
              onChange={(e) => onChange({ ...value, instructions: e.target.value })}
            />
          </label>
          <p className="skills-moment-help">{t('skills.storageCommands')}</p>
          <p className="skills-secret">
            <strong>{t('skills.secretTitle')}</strong> {t('skills.secretBody')}
          </p>
        </>
      ) : null}
      <p className="skills-moment-help">
        {t('skills.storageSetup')} <code className="skills-moment-command">/kory-setup-handoff</code>
      </p>
    </section>
  )
}

function CommandsField({
  moment,
  rows,
  onEdit,
  onMove,
  onRemove,
  onAdd
}: {
  moment: (typeof MOMENTS)[number]
  rows: Row[]
  onEdit: (id: number, text: string) => void
  onMove: (index: number, delta: -1 | 1) => void
  onRemove: (id: number) => void
  onAdd: () => void
}): React.JSX.Element {
  const t = useT()
  const labelId = useId()
  const full = rows.length >= SESSION_COMMAND_LIMITS.linesPerMoment
  // The native skill is drawn at the place it is typed: after the list on start, before it on end and stop.
  const native = (
    <li className="skills-command" data-native aria-label={t('skills.commandNative')}>
      <span className="skills-command-index">{GLYPH_BADGES.lock}</span>
      <code className="skills-command-fixed">{moment.command}</code>
    </li>
  )
  return (
    <div className="skills-commands" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="skills-commands-label">
        {t('skills.commandsLabel')}
      </span>
      <p className="skills-moment-help">{t(moment.commandsHelpKey)}</p>
      <ol className="skills-command-list">
        {moment.id === 'start' ? null : native}
        {rows.map((row, i) => {
          const checked = blankLine(row.text) ? null : checkConfiguredLine(row.text)
          return (
            <li key={row.id} className="skills-command" data-state={checked === null ? 'blank' : checked.ok ? 'valid' : 'refused'}>
              <span className="skills-command-index">{i + 1}</span>
              <input
                className="skills-command-input"
                type="text"
                value={row.text}
                spellCheck={false}
                placeholder={t('skills.commandPlaceholder')}
                aria-label={t('skills.commandLine', { line: i + 1 })}
                aria-invalid={checked !== null && !checked.ok ? true : undefined}
                onChange={(e) => onEdit(row.id, e.target.value)}
              />
              <span className="skills-command-tools">
                <button className="icon-btn" disabled={i === 0} aria-label={t('skills.commandUp')} title={t('skills.commandUp')} onClick={() => onMove(i, -1)}>
                  {GLYPH_ACTIONS.up}
                </button>
                <button
                  className="icon-btn"
                  disabled={i === rows.length - 1}
                  aria-label={t('skills.commandDown')}
                  title={t('skills.commandDown')}
                  onClick={() => onMove(i, 1)}
                >
                  {GLYPH_ACTIONS.down}
                </button>
                <button className="icon-btn" aria-label={t('skills.commandRemove')} title={t('skills.commandRemove')} onClick={() => onRemove(row.id)}>
                  {GLYPH_ACTIONS.close}
                </button>
              </span>
              {checked === null ? null : checked.ok ? (
                <small className="skills-command-note">{t(CLASS_KEYS[checked.commandClass])}</small>
              ) : (
                <small className="skills-command-note skills-command-error">
                  {t(REFUSAL_KEYS[checked.reason], {
                    max: checked.reason === 'args-too-long' ? SESSION_COMMAND_LIMITS.args : SESSION_COMMAND_LIMITS.command
                  })}
                </small>
              )}
            </li>
          )
        })}
        {moment.id === 'start' ? native : null}
      </ol>
      {rows.length === 0 ? <p className="skills-hint">{t('skills.commandsEmpty')}</p> : null}
      <div className="skills-command-add">
        <button className="chip" disabled={full} onClick={onAdd}>
          {GLYPH_ACTIONS.plus} {t('skills.commandAdd')}
        </button>
        {full ? <small className="skills-hint">{t('skills.commandMax', { max: SESSION_COMMAND_LIMITS.linesPerMoment })}</small> : null}
      </div>
    </div>
  )
}

function MomentField({
  moment,
  value,
  onChange,
  children
}: {
  moment: (typeof MOMENTS)[number]
  value: string
  onChange: (text: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  const t = useT()
  const titleId = useId()
  const labelId = useId()
  return (
    <section className="skills-moment" aria-labelledby={titleId}>
      <header className="skills-moment-head">
        <h3 id={titleId}>{t(moment.titleKey)}</h3>
        <code className="skills-moment-command">{moment.command}</code>
      </header>
      <p className="skills-moment-help">{t(moment.helpKey)}</p>
      <label className="field skills-field">
        <span id={labelId}>{t('skills.addendumLabel')}</span>
        <textarea
          aria-labelledby={`${titleId} ${labelId}`}
          aria-invalid={tooLarge(value) || undefined}
          value={value}
          rows={5}
          spellCheck={false}
          placeholder={t('skills.addendumPlaceholder')}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      {children}
    </section>
  )
}

export function SkillsSettings(): React.JSX.Element {
  const t = useT()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [saved, setSaved] = useState<SessionSkillAddendum>(EMPTY)
  const [draft, setDraft] = useState<SessionSkillAddendum>(EMPTY)
  const [savedStorage, setSavedStorage] = useState<Storage>(KORY_STORAGE)
  const [draftStorage, setDraftStorage] = useState<Storage>(KORY_STORAGE)
  const [savedCommands, setSavedCommands] = useState<SessionSkillCommands>(NO_COMMANDS)
  const [draftCommands, setDraftCommands] = useState<DraftCommands>({ start: [], end: [], stop: [] })
  const [save, setSave] = useState<Save>({ kind: 'idle' })
  const nextRowId = useRef(0)
  // Counts every row action: a blank row added after Save cleans to the same lines, so only this tells it apart.
  const commandsRevision = useRef(0)

  const rowsOf = (commands: SessionSkillCommands): DraftCommands => {
    const rows = (lines: readonly string[]): Row[] => lines.map((text) => ({ id: nextRowId.current++, text }))
    return { start: rows(commands.start), end: rows(commands.end), stop: rows(commands.stop) }
  }

  const read = async (): Promise<void> => {
    setLoad({ kind: 'loading' })
    try {
      const settings = await window.api.getSessionSkills()
      setSaved(settings.addendum)
      setDraft(settings.addendum)
      setSavedStorage(settings.storage)
      setDraftStorage(settings.storage)
      setSavedCommands(settings.commands)
      setDraftCommands(rowsOf(settings.commands))
      setSave({ kind: 'idle' })
      setLoad({ kind: 'ready' })
    } catch (e) {
      window.api.reportError('settings', `getSessionSkills failed: ${String(e)}`)
      setLoad({ kind: 'invalid', message: errorText(e) })
    }
  }

  useEffect(() => {
    void read()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only read, like RulesSettings
  }, [])

  const cleanDraftCommands = cleanCommands(draftCommands)
  const dirty =
    !sameAddendum(draft, saved) || !sameStorage(draftStorage, savedStorage) || !sameCommands(cleanDraftCommands, savedCommands)
  const incomplete = blankCustom(draftStorage)
  const oversized = [
    ...(tooLarge(draftStorage.instructions) ? [t('skills.storageTitle')] : []),
    ...MOMENTS.filter((m) => tooLarge(draft[m.id])).map((m) => t(m.titleKey))
  ]
  // Use the displayed row index so the operator can find the invalid input.
  const refusedLines = MOMENTS.flatMap((m) =>
    draftCommands[m.id].flatMap((row, i) =>
      !blankLine(row.text) && !checkConfiguredLine(row.text).ok ? [t('skills.commandRefusedAt', { moment: t(m.titleKey), line: i + 1 })] : []
    )
  )

  const touched = (): void => {
    if (save.kind === 'saved') setSave({ kind: 'idle' })
  }

  const edit = (moment: Moment, text: string): void => {
    setDraft((d) => ({ ...d, [moment]: text }))
    touched()
  }

  const editStorage = (next: Storage): void => {
    setDraftStorage(next)
    touched()
  }

  const editRows = (moment: Moment, change: (rows: Row[]) => Row[]): void => {
    commandsRevision.current++
    setDraftCommands((d) => ({ ...d, [moment]: change(d[moment]) }))
    touched()
  }

  const moveRow = (rows: Row[], index: number, delta: -1 | 1): Row[] => {
    const to = index + delta
    if (to < 0 || to >= rows.length) return rows
    const next = rows.slice()
    ;[next[index], next[to]] = [next[to]!, next[index]!]
    return next
  }

  const submit = async (): Promise<void> => {
    const sent: SessionSkillAddendum = { start: draft.start, end: draft.end, stop: draft.stop }
    const sentStorage: Storage = { mode: draftStorage.mode, instructions: draftStorage.instructions }
    const sentCommands = cleanDraftCommands
    const sentRevision = commandsRevision.current
    const value: SessionSkillSettings = { version: 3, addendum: sent, storage: sentStorage, commands: sentCommands }
    setSave({ kind: 'saving' })
    try {
      const stored = await window.api.setSessionSkills(value)
      setSaved(stored.addendum)
      setSavedStorage(stored.storage)
      setSavedCommands(stored.commands)
      // Only when nothing was typed since the click, or those keystrokes are lost.
      setDraft((d) => (sameAddendum(d, sent) ? stored.addendum : d))
      setDraftStorage((s) => (sameStorage(s, sentStorage) ? stored.storage : s))
      setDraftCommands((d) =>
        commandsRevision.current !== sentRevision ? d : sameCommands(sentCommands, stored.commands) ? dropBlankRows(d) : rowsOf(stored.commands)
      )
      setSave({ kind: 'saved' })
    } catch (e) {
      window.api.reportError('settings', `setSessionSkills failed: ${String(e)}`)
      setSave({ kind: 'error', message: errorText(e) })
    }
  }

  if (load.kind === 'loading') {
    return (
      <div className="skills-settings" data-state="loading" aria-busy="true">
        <p className="skills-hint">{t('skills.loading')}</p>
      </div>
    )
  }

  if (load.kind === 'invalid') {
    return (
      <div className="skills-settings" data-state="invalid">
        <div className="skills-invalid" role="alert">
          <p className="skills-invalid-title">
            {GLYPH_BADGES.warning} {t('skills.invalidTitle')}
          </p>
          <p className="skills-invalid-body">{t('skills.invalidBody')}</p>
          <pre className="skills-invalid-message">{load.message}</pre>
          <div>
            <button className="btn" onClick={() => void read()}>
              {t('rules.retry')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const saving = save.kind === 'saving'
  const empty = !dirty && sameAddendum(saved, EMPTY) && savedStorage.mode === 'kory' && sameCommands(savedCommands, NO_COMMANDS)
  const state = save.kind === 'error' ? 'error' : dirty ? 'dirty' : save.kind === 'saved' ? 'saved' : 'clean'

  return (
    <div className="skills-settings" data-state={state}>
      <div className="skills-scope">
        <p>{t('skills.scope')}</p>
        <p className="skills-scope-dim">{t('skills.notCommands')}</p>
        <p className="skills-scope-dim">{t('skills.commandsUnknown')}</p>
      </div>
      <p className="skills-secret">
        <strong>{t('skills.secretTitle')}</strong> {t('skills.secretBody')}
      </p>
      {empty ? <p className="skills-hint">{t('skills.empty')}</p> : null}

      <StorageField value={draftStorage} onChange={editStorage} />

      {MOMENTS.map((m) => (
        <MomentField key={m.id} moment={m} value={draft[m.id]} onChange={(text) => edit(m.id, text)}>
          <CommandsField
            moment={m}
            rows={draftCommands[m.id]}
            onEdit={(id, text) => editRows(m.id, (rows) => rows.map((r) => (r.id === id ? { ...r, text } : r)))}
            onMove={(index, delta) => editRows(m.id, (rows) => moveRow(rows, index, delta))}
            onRemove={(id) => editRows(m.id, (rows) => rows.filter((r) => r.id !== id))}
            onAdd={() =>
              editRows(m.id, (rows) =>
                rows.length >= SESSION_COMMAND_LIMITS.linesPerMoment ? rows : [...rows, { id: nextRowId.current++, text: '' }]
              )
            }
          />
        </MomentField>
      ))}

      <div className="skills-actions">
        <button
          className="primary"
          disabled={!dirty || saving || incomplete || oversized.length > 0 || refusedLines.length > 0}
          onClick={() => void submit()}
        >
          {saving ? t('skills.saving') : t('common.save')}
        </button>
        {save.kind === 'error' ? (
          <p className="skills-status skills-status-error" role="alert">
            {GLYPH_BADGES.warning} {t('skills.saveError')} <span className="skills-status-message">{save.message}</span>
          </p>
        ) : oversized.length > 0 ? (
          <p className="skills-status">
            {t('skills.tooLarge', { limit: SESSION_SKILL_TEXT_MAX_BYTES / 1024, fields: oversized.join(', ') })}
          </p>
        ) : refusedLines.length > 0 ? (
          <p className="skills-status">{t('skills.commandRefused', { lines: refusedLines.join(', ') })}</p>
        ) : incomplete ? (
          <p className="skills-status">{t('skills.storageEmpty')}</p>
        ) : dirty ? (
          <p className="skills-status">{t('skills.unsaved')}</p>
        ) : save.kind === 'saved' ? (
          <p className="skills-status" role="status">
            {GLYPH_ACTIONS.check} {t('skills.saved')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
