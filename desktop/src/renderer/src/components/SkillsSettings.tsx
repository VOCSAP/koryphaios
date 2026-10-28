import { useEffect, useId, useState } from 'react'
import type { SessionSkillAddendum, SessionSkillSettings } from '@shared/types'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { errorText } from '../store'
import { useT } from '../i18n'

type Moment = keyof SessionSkillAddendum

const MOMENTS: { id: Moment; command: string; titleKey: string; helpKey: string }[] = [
  { id: 'start', command: '/kory-session-start', titleKey: 'skills.startTitle', helpKey: 'skills.startHelp' },
  { id: 'end', command: '/kory-session-end', titleKey: 'skills.endTitle', helpKey: 'skills.endHelp' },
  { id: 'stop', command: '/kory-session-stop', titleKey: 'skills.stopTitle', helpKey: 'skills.stopHelp' }
]

const EMPTY: SessionSkillAddendum = { start: '', end: '', stop: '' }

type Load = { kind: 'loading' } | { kind: 'invalid'; message: string } | { kind: 'ready' }
type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

const sameAddendum = (a: SessionSkillAddendum, b: SessionSkillAddendum): boolean =>
  a.start === b.start && a.end === b.end && a.stop === b.stop

function MomentField({
  moment,
  value,
  onChange
}: {
  moment: (typeof MOMENTS)[number]
  value: string
  onChange: (text: string) => void
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
          value={value}
          rows={5}
          spellCheck={false}
          placeholder={t('skills.addendumPlaceholder')}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </section>
  )
}

export function SkillsSettings(): React.JSX.Element {
  const t = useT()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [saved, setSaved] = useState<SessionSkillAddendum>(EMPTY)
  const [draft, setDraft] = useState<SessionSkillAddendum>(EMPTY)
  const [save, setSave] = useState<Save>({ kind: 'idle' })

  const read = async (): Promise<void> => {
    setLoad({ kind: 'loading' })
    try {
      const settings = await window.api.getSessionSkills()
      setSaved(settings.addendum)
      setDraft(settings.addendum)
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

  const dirty = !sameAddendum(draft, saved)

  const edit = (moment: Moment, text: string): void => {
    setDraft((d) => ({ ...d, [moment]: text }))
    if (save.kind === 'saved') setSave({ kind: 'idle' })
  }

  const submit = async (): Promise<void> => {
    const sent: SessionSkillAddendum = { start: draft.start, end: draft.end, stop: draft.stop }
    const value: SessionSkillSettings = { version: 1, addendum: sent }
    setSave({ kind: 'saving' })
    try {
      const stored = await window.api.setSessionSkills(value)
      setSaved(stored.addendum)
      // Only when nothing was typed since the click, or those keystrokes are lost.
      setDraft((d) => (sameAddendum(d, sent) ? stored.addendum : d))
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
  const empty = !dirty && sameAddendum(saved, EMPTY)
  const state = save.kind === 'error' ? 'error' : dirty ? 'dirty' : save.kind === 'saved' ? 'saved' : 'clean'

  return (
    <div className="skills-settings" data-state={state}>
      <div className="skills-scope">
        <p>{t('skills.scope')}</p>
        <p className="skills-scope-dim">{t('skills.notCommands')}</p>
      </div>
      <p className="skills-secret">
        <strong>{t('skills.secretTitle')}</strong> {t('skills.secretBody')}
      </p>
      {empty ? <p className="skills-hint">{t('skills.empty')}</p> : null}

      {MOMENTS.map((m) => (
        <MomentField key={m.id} moment={m} value={draft[m.id]} onChange={(text) => edit(m.id, text)} />
      ))}

      <div className="skills-actions">
        <button className="primary" disabled={!dirty || saving} onClick={() => void submit()}>
          {saving ? t('skills.saving') : t('common.save')}
        </button>
        {save.kind === 'error' ? (
          <p className="skills-status skills-status-error" role="alert">
            {GLYPH_BADGES.warning} {t('skills.saveError')} <span className="skills-status-message">{save.message}</span>
          </p>
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
