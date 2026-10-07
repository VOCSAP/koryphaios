import type { ReactNode } from 'react'
import type { Approval } from '@shared/types'
import { GLYPH_ACTIONS } from './icons'
import { useT } from '../i18n'
import {
  OTHER_MAX,
  buildAnswers,
  cleanOther,
  completedCount,
  emptyDrafts,
  formQuestions,
  isOneClick,
  otherLength,
  questionComplete,
  setOtherText,
  toggleOption,
  toggleOther,
  type QuestionDraft
} from './approval-answers'

interface Props {
  /** A request on reply_route 'hook': the module waits on it, nothing is typed into a terminal. */
  approval: Pick<Approval, 'id' | 'kind' | 'questions'>
  disabled: boolean
  /** Controlled, so a draft survives the host closing and reopening it. */
  draft: QuestionDraft[] | undefined
  onDraft: (draft: QuestionDraft[]) => void
  onAllow: () => void
  onDeny: () => void
  onAnswers: (answers: Record<string, string[]>) => void
  onHandback: () => void
  /** Host buttons (Close) placed between the handback and the answering buttons. */
  children?: ReactNode
  actionsClassName: string
}

/**
 * Answers a request the Claude Code module is waiting on. A permission takes
 * Allow or Deny once each; questions take structured answers only, so there is
 * no Deny and no free reply: anything else would read as "no verdict" to the
 * module. Handing back to the terminal is always offered, apart from the
 * verdicts, because it decides nothing.
 */
export function ApprovalAnswerForm(props: Props): React.JSX.Element {
  const t = useT()
  const { approval, disabled } = props
  const questions = formQuestions(approval)
  const drafts = props.draft ?? (questions ? emptyDrafts(questions) : [])
  const oneClick = questions !== null && isOneClick(questions)
  const answers = questions ? buildAnswers(questions, drafts) : null

  const handback = (
    <button
      className="btn approval-handback"
      disabled={disabled}
      title={t('inbox.handbackTitle')}
      onClick={props.onHandback}
    >
      {GLYPH_ACTIONS.back}
      {t('inbox.handback')}
    </button>
  )

  const otherField = (i: number, d: QuestionDraft): React.JSX.Element => (
    <>
      <input
        type="text"
        className="aq-other-input"
        value={d.otherText}
        disabled={disabled}
        placeholder={t('inbox.questionOtherPlaceholder')}
        aria-label={t('inbox.questionOther')}
        onChange={(ev) => props.onDraft(setOtherText(drafts, i, ev.target.value))}
      />
      <span className={`aq-count${otherLength(d.otherText) >= OTHER_MAX ? ' is-full' : ''}`}>
        {t('inbox.questionOtherCount', { n: otherLength(d.otherText), max: OTHER_MAX })}
      </span>
    </>
  )

  return (
    <>
      {questions?.map((q, i) => {
        const d = drafts[i]
        if (!d) return null
        const missing = !oneClick && !questionComplete(q, d)
        return (
          <fieldset key={i} className="aq">
            <legend className="aq-head">
              {q.header && <span className="aq-tag">{q.header}</span>}
              <span className="aq-q">{q.question}</span>
              {!oneClick && (
                <span className={`aq-mode${missing ? ' is-missing' : ''}`}>
                  {missing
                    ? t('inbox.questionMissing')
                    : t(q.multi_select ? 'inbox.questionManyChoices' : 'inbox.questionOneChoice')}
                </span>
              )}
            </legend>
            <div className="aq-opts">
              {q.options.map((o, oi) =>
                oneClick ? (
                  <button
                    key={oi}
                    className="aq-pick"
                    disabled={disabled}
                    onClick={() => props.onAnswers(Object.fromEntries([[q.question, [o.label]]]))}
                  >
                    <span className="aq-label">{o.label}</span>
                    {GLYPH_ACTIONS.forward}
                    {o.description && <span className="aq-desc">{o.description}</span>}
                  </button>
                ) : (
                  <label key={oi} className={`aq-opt${d.picked.includes(oi) ? ' is-on' : ''}`}>
                    <input
                      type={q.multi_select ? 'checkbox' : 'radio'}
                      name={`aq-${approval.id}-${i}`}
                      checked={d.picked.includes(oi)}
                      disabled={disabled}
                      onChange={() => props.onDraft(toggleOption(drafts, q, i, oi))}
                    />
                    <span className="aq-label">{o.label}</span>
                    {o.description && <span className="aq-desc">{o.description}</span>}
                  </label>
                )
              )}
              {oneClick ? (
                <div className="aq-opt aq-other is-free">
                  <span className="aq-label">{t('inbox.questionOther')}</span>
                  {otherField(i, d)}
                </div>
              ) : (
                <label className={`aq-opt aq-other${d.other ? ' is-on' : ''}`}>
                  <input
                    type={q.multi_select ? 'checkbox' : 'radio'}
                    name={`aq-${approval.id}-${i}`}
                    checked={d.other}
                    disabled={disabled}
                    onChange={() => props.onDraft(toggleOther(drafts, q, i))}
                  />
                  <span className="aq-label">{t('inbox.questionOther')}</span>
                  {d.other && otherField(i, d)}
                </label>
              )}
            </div>
          </fieldset>
        )
      })}

      {approval.kind !== 'permission' && !questions && (
        <div className="inbox-modal-note">{t('inbox.noQuestions')}</div>
      )}

      {questions && !oneClick && (
        <div className="aq-progress">
          {t('inbox.questionsProgress', { done: completedCount(questions, drafts), total: questions.length })}
        </div>
      )}
      <div className={props.actionsClassName}>
        {handback}
        <span className="approval-actions-spacer" />
        {props.children}
        {approval.kind === 'permission' && (
          <>
            <button className="btn danger" disabled={disabled} onClick={props.onDeny}>
              {t('inbox.permissionDeny')}
            </button>
            <button className="primary" disabled={disabled} onClick={props.onAllow}>
              {t('inbox.permissionAllow')}
            </button>
          </>
        )}
        {questions && oneClick && (
          <button
            className="primary"
            disabled={disabled || cleanOther(drafts[0]?.otherText ?? '') === ''}
            onClick={() => {
              const text = cleanOther(drafts[0]?.otherText ?? '')
              if (text) props.onAnswers(Object.fromEntries([[questions[0]!.question, [text]]]))
            }}
          >
            {t('inbox.sendOther')}
          </button>
        )}
        {questions && !oneClick && (
          <button
            className="primary"
            disabled={disabled || answers === null}
            onClick={() => {
              if (answers) props.onAnswers(answers)
            }}
          >
            {t('inbox.sendAnswers')}
          </button>
        )}
      </div>
      {approval.kind === 'permission' && (
        <div className="inbox-modal-note">{t('inbox.allowOnceNote')}</div>
      )}
    </>
  )
}
