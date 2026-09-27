// Settings > Rules: the operator's view of the three guard-rule sources.
// Kory built-ins are read-only; global and repo rules can be viewed, edited
// (through a full-file rewrite) or deleted, and a pending or invalid repo
// file locks its rules to read-only until approved. Mounted only while the
// category is open, like BrokerSettings: `rulesList` re-reads the three
// sources on every visit, and `onRulesChanged` keeps the table live while the
// tab stays open (a repo agent editing rules.json, a watcher picking up an
// approval elsewhere). A row's owning project is passed down explicitly by
// the section that renders it, never re-derived from `toggleKey`: two
// worktrees of the same project share every toggleKey prefix, so resolving
// "the project that has a rule with this toggleKey" would land on whichever
// worktree happens to be first in the list.

import { useEffect, useState } from 'react'
import type { TtsrFileState, TtsrRepoProject, TtsrRuleRow, TtsrRulesList } from '@shared/types'
import type { TtsrRule } from '@shared/ttsr-types'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { ConfirmDialog } from './ConfirmDialog'
import { RuleEditorModal, type RuleEditTarget } from './RuleEditorModal'
import { RulesRawEditorModal } from './RulesRawEditorModal'
import { useT, type TFn } from '../i18n'

/** Basename of a filesystem path without pulling `node:path` into the renderer bundle. */
function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function hookLabel(t: TFn, rule: TtsrRule): string {
  const event = rule.event === 'PreToolUse' ? t('rules.eventPre') : t('rules.eventPost')
  return `${event} · ${rule.tools.join(', ')}`
}

function SourceBadge({ source, t }: { source: TtsrRuleRow['source']; t: TFn }): React.JSX.Element {
  const label =
    source === 'kory' ? t('rules.sourceKory') : source === 'user' ? t('rules.sourceGlobal') : t('rules.sourceRepo')
  return <span className="rules-badge">{label}</span>
}

function FileStatusBadge({ status, t }: { status: TtsrFileState['status']; t: TFn }): React.JSX.Element | null {
  if (status === 'absent') return null
  if (status === 'pending')
    return (
      <span className="rules-badge rules-badge-pending">
        {GLYPH_BADGES.clepsydra} {t('rules.badgePending')}
      </span>
    )
  if (status === 'invalid')
    return (
      <span className="rules-badge rules-badge-invalid">
        {GLYPH_BADGES.warning} {t('rules.badgeInvalid')}
      </span>
    )
  return null
}

interface RowProps {
  row: TtsrRuleRow
  t: TFn
  toggleDisabledReason: string | null
  /** Non-null while the row's own file (repo: pending/invalid) locks Edit/Delete to View-only. */
  editDisabledReason?: string | null
  onToggle: (row: TtsrRuleRow, enabled: boolean) => void
  onOpen: (row: TtsrRuleRow) => void
}

function RuleRow({ row, t, toggleDisabledReason, editDisabledReason = null, onToggle, onOpen }: RowProps): React.JSX.Element {
  const viewOnly = row.source === 'kory' || editDisabledReason !== null
  return (
    <div className="rules-row">
      <div className="rules-row-name">
        <span className="rules-row-id" title={row.qualifiedId}>
          {row.qualifiedId}
        </span>
        <SourceBadge source={row.source} t={t} />
      </div>
      <div className="rules-row-hook">{hookLabel(t, row.rule)}</div>
      <div className="rules-row-def">
        <button className="btn btn-sm" title={editDisabledReason ?? undefined} onClick={() => onOpen(row)}>
          {viewOnly ? t('rules.view') : t('rules.edit')}
        </button>
      </div>
      <div className="rules-row-active" title={toggleDisabledReason ?? undefined}>
        <input
          type="checkbox"
          checked={row.enabled}
          disabled={toggleDisabledReason !== null}
          onChange={(e) => onToggle(row, e.target.checked)}
        />
      </div>
    </div>
  )
}

function TableHead({ t }: { t: TFn }): React.JSX.Element {
  return (
    <div className="rules-table-head">
      <span>{t('rules.colName')}</span>
      <span>{t('rules.colHook')}</span>
      <span>{t('rules.colDefinition')}</span>
      <span>{t('rules.colActive')}</span>
    </div>
  )
}

export function RulesSettings(): React.JSX.Element {
  const t = useT()
  const [list, setList] = useState<TtsrRulesList | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [editing, setEditing] = useState<{
    mode: 'view' | 'edit' | 'add'
    target: RuleEditTarget
    rule: TtsrRule | null
    existingRules: TtsrRule[]
    /** `file.hash` of the file state this modal was opened from; null when the file was absent. */
    expectedHash: string | null
  } | null>(null)
  const [rawEditing, setRawEditing] = useState<{ target: RuleEditTarget; text: string; expectedHash: string | null } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{
    target: RuleEditTarget
    rule: TtsrRule
    existingRules: TtsrRule[]
    expectedHash: string | null
  } | null>(null)

  const load = async (): Promise<void> => {
    try {
      const next = await window.api.rulesList()
      setList(next)
      setLoadError(false)
    } catch (e) {
      window.api.reportError('rules', `rulesList failed: ${String(e)}`)
      setLoadError(true)
    }
  }

  useEffect(() => {
    void load()
    return window.api.onRulesChanged((next) => setList(next))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load() is stable enough for a mount-only effect
  }, [])

  const onToggle = async (row: TtsrRuleRow, enabled: boolean): Promise<void> => {
    try {
      const next = await window.api.rulesSetEnabled(row.toggleKey, enabled)
      setList(next)
    } catch (e) {
      window.api.reportError('rules', `rulesSetEnabled(${row.toggleKey}) failed: ${String(e)}`)
    }
  }

  const onApprove = async (project: TtsrRepoProject): Promise<void> => {
    if (project.file.hash === null) return
    try {
      const res = await window.api.rulesApproveRepo(project.projectDir, project.file.hash)
      if (!res.ok) {
        if (res.reason === 'stale') {
          setNotice(t('rules.approveStale'))
          await load()
        } else {
          window.api.reportError('rules', `rulesApproveRepo(${project.projectDir}) refused: ${res.reason}`)
        }
        return
      }
      setNotice(null)
      await load()
    } catch (e) {
      window.api.reportError('rules', `rulesApproveRepo(${project.projectDir}) failed: ${String(e)}`)
    }
  }

  // `row` is opened together with the `project` its OWN section rendered it
  // under (undefined for kory/global rows) -- never re-derived by scanning
  // every project for a matching toggleKey, which two worktrees sharing a
  // project_key would answer with whichever one happens to come first.
  const openView = (row: TtsrRuleRow, project?: TtsrRepoProject): void => {
    if (row.source === 'kory') {
      setEditing({ mode: 'view', target: { kind: 'global' }, rule: row.rule, existingRules: [], expectedHash: null })
      return
    }
    if (row.source === 'user') {
      setEditing({
        mode: 'edit',
        target: { kind: 'global' },
        rule: row.rule,
        existingRules: (list?.global.rules ?? []).map((r) => r.rule),
        expectedHash: list?.global.file.hash ?? null
      })
      return
    }
    if (!project) return
    const locked = project.file.status !== 'approved'
    setEditing({
      mode: locked ? 'view' : 'edit',
      target: { kind: 'repo', projectDir: project.projectDir },
      rule: row.rule,
      existingRules: project.rules.map((r) => r.rule),
      expectedHash: project.file.hash
    })
  }

  const openAddGlobal = (): void => {
    setEditing({
      mode: 'add',
      target: { kind: 'global' },
      rule: null,
      existingRules: (list?.global.rules ?? []).map((r) => r.rule),
      expectedHash: list?.global.file.hash ?? null
    })
  }

  const openAddRepo = (project: TtsrRepoProject): void => {
    setEditing({
      mode: 'add',
      target: { kind: 'repo', projectDir: project.projectDir },
      rule: null,
      existingRules: project.rules.map((r) => r.rule),
      expectedHash: project.file.hash
    })
  }

  const requestDelete = (target: RuleEditTarget, rule: TtsrRule, existingRules: TtsrRule[], expectedHash: string | null): void => {
    setPendingDelete({ target, rule, existingRules, expectedHash })
  }

  /** Common handling for a save/delete refused as `stale` or `pending`: never overwrite, tell the operator, reload. */
  const handleSaveConflict = (reason: 'stale' | 'pending'): void => {
    setNotice(reason === 'stale' ? t('rules.saveStale') : t('rules.savePending'))
    setEditing(null)
    setRawEditing(null)
    void load()
  }

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const { target, rule, existingRules, expectedHash } = pendingDelete
    setPendingDelete(null)
    setEditing(null)
    const rules = existingRules.filter((r) => r.id !== rule.id)
    const text = JSON.stringify({ version: 1, rules }, null, 2) + '\n'
    try {
      const res =
        target.kind === 'global'
          ? await window.api.rulesSaveGlobal(text, expectedHash)
          : await window.api.rulesSaveRepo(target.projectDir, text, expectedHash)
      if (!res.ok) {
        if (res.reason === 'stale' || res.reason === 'pending') handleSaveConflict(res.reason)
        else window.api.reportError('rules', `delete rule "${rule.id}" failed: ${res.errors.join('; ')}`)
      }
    } catch (e) {
      window.api.reportError('rules', `delete rule "${rule.id}" failed: ${String(e)}`)
    }
  }

  const onEditorSaved = (approved: boolean): void => {
    setEditing(null)
    if (!approved) setNotice(t('rules.savedPendingApproval'))
  }

  const onRawSaved = (approved: boolean): void => {
    setRawEditing(null)
    if (!approved) setNotice(t('rules.savedPendingApproval'))
  }

  if (loadError) {
    return (
      <div className="field">
        <span>{t('rules.loadError')}</span>
        <div>
          <button className="btn" onClick={() => void load()}>
            {t('rules.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (list === null) {
    return (
      <div className="field">
        <span>{t('rules.loading')}</span>
      </div>
    )
  }

  return (
    <div className="rules-settings">
      {notice !== null ? (
        <div className="rules-notice">
          <span>{notice}</span>
          <button className="icon-btn" title={t('common.close')} onClick={() => setNotice(null)}>
            {GLYPH_ACTIONS.close}
          </button>
        </div>
      ) : null}

      {/* ----- Kory built-in rules: read-only, toggle only ----- */}
      <section className="rules-section">
        <h3>{t('rules.korySection')}</h3>
        <div className="rules-table">
          <TableHead t={t} />
          {list.kory.map((row) => (
            <RuleRow key={row.qualifiedId} row={row} t={t} toggleDisabledReason={null} onToggle={onToggle} onOpen={openView} />
          ))}
        </div>
      </section>

      {/* ----- Global rules: operator-authored, no approval step ----- */}
      <section className="rules-section">
        <h3>{t('rules.globalSection')}</h3>
        {list.global.file.status === 'invalid' ? (
          <div className="rules-file-invalid">
            <ul>
              {list.global.file.errors.map((err, i) => (
                <li key={i} className="field-error">
                  {err}
                </li>
              ))}
            </ul>
            <button
              className="btn"
              onClick={() =>
                setRawEditing({
                  target: { kind: 'global' },
                  text: list.global.file.text ?? '',
                  expectedHash: list.global.file.hash
                })
              }
            >
              {t('rules.editRawFile')}
            </button>
          </div>
        ) : (
          <div className="rules-table">
            <TableHead t={t} />
            {list.global.rules.map((row) => (
              <RuleRow key={row.qualifiedId} row={row} t={t} toggleDisabledReason={null} onToggle={onToggle} onOpen={openView} />
            ))}
          </div>
        )}
        <div>
          <button className="primary" onClick={openAddGlobal}>
            {t('rules.addRule')}
          </button>
        </div>
      </section>

      {/* ----- Repo rules: one section per live project, gated by approval.
          Keyed and closed over by `project.projectDir`, never `projectKey`:
          two worktrees of the same repo share a project_key but each owns its
          own file, hash and rules. ----- */}
      {list.projects.map((project) => {
        const locked = project.file.status !== 'approved'
        const editDisabledReason = locked ? t('rules.editDisabledPending') : null
        return (
          <section className="rules-section" key={project.projectDir}>
            <h3 title={project.projectDir}>{baseName(project.projectDir)}</h3>
            <FileStatusBadge status={project.file.status} t={t} />
            {project.file.removedApproved === true ? (
              <p className="field-error">{t('rules.approvedRemoved')}</p>
            ) : project.file.previousHash !== undefined ? (
              <p className="field-error">{t('rules.approvedChanged')}</p>
            ) : null}
            {project.file.status === 'pending' ? (
              <div className="rules-approve-row">
                <button className="primary" onClick={() => void onApprove(project)}>
                  {t('rules.approve')}
                </button>
              </div>
            ) : null}
            {project.file.status === 'invalid' ? (
              <div className="rules-file-invalid">
                <ul>
                  {project.file.errors.map((err, i) => (
                    <li key={i} className="field-error">
                      {err}
                    </li>
                  ))}
                </ul>
                <button
                  className="btn"
                  onClick={() =>
                    setRawEditing({
                      target: { kind: 'repo', projectDir: project.projectDir },
                      text: project.file.text ?? '',
                      expectedHash: project.file.hash
                    })
                  }
                >
                  {t('rules.editRawFile')}
                </button>
              </div>
            ) : null}
            {project.file.status === 'absent' ? <p className="rules-empty-hint">{t('rules.absentHint')}</p> : null}
            {project.file.status === 'pending' || project.file.status === 'approved' ? (
              <div className="rules-table">
                <TableHead t={t} />
                {project.rules.map((row) => (
                  <RuleRow
                    key={row.qualifiedId}
                    row={row}
                    t={t}
                    toggleDisabledReason={locked ? t('rules.toggleDisabledPending') : null}
                    editDisabledReason={editDisabledReason}
                    onToggle={onToggle}
                    onOpen={(r) => openView(r, project)}
                  />
                ))}
              </div>
            ) : null}
            {project.file.status !== 'invalid' ? (
              <div>
                <button
                  className="primary"
                  disabled={locked}
                  title={locked ? t('rules.addDisabledPending') : undefined}
                  onClick={() => openAddRepo(project)}
                >
                  {t('rules.addRule')}
                </button>
              </div>
            ) : null}
          </section>
        )
      })}

      {editing !== null && (
        <RuleEditorModal
          mode={editing.mode}
          target={editing.target}
          rule={editing.rule}
          existingRules={editing.existingRules}
          expectedHash={editing.expectedHash}
          onClose={() => setEditing(null)}
          onSaved={onEditorSaved}
          onConflict={handleSaveConflict}
          onDeleteRequested={
            editing.mode === 'edit' && editing.rule !== null
              ? () => requestDelete(editing.target, editing.rule as TtsrRule, editing.existingRules, editing.expectedHash)
              : undefined
          }
        />
      )}

      {rawEditing !== null && (
        <RulesRawEditorModal
          target={rawEditing.target}
          initialText={rawEditing.text}
          expectedHash={rawEditing.expectedHash}
          onClose={() => setRawEditing(null)}
          onSaved={onRawSaved}
          onConflict={handleSaveConflict}
        />
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title={t('rules.deleteConfirmTitle')}
          message={t('rules.deleteConfirmMessage', { id: pendingDelete.rule.id })}
          confirmLabel={t('common.delete')}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
