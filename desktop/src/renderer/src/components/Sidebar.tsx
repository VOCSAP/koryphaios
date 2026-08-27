import { useState } from 'react'
import type { SessionRuntime } from '@shared/types'
import { moveBeside } from '@shared/reorder'
import { GLYPH_ACTIONS, GLYPH_BADGES, GLYPHS, PithosGlyph, roleGlyph } from './icons'
import { useDeck } from '../store'
import { formatPeerTable } from '../peer-table'
import { formatClock, useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu } from './ContextMenu'
import { CreateMenu } from './CreateMenu'
import { MessageBar } from './MessageBar'

/** Drag-and-drop wiring passed from the Sidebar down to each row. */
export interface RowDnd {
  dragId: string | null
  overId: string | null
  onDragStart: (id: string) => void
  onDragEnter: (id: string) => void
  onDrop: (e: React.DragEvent, id: string) => void
  onDragEnd: () => void
}

// Exported (was file-local) so tests/desktop-sidebar-autoresume-dom.test.ts
// can mount ONE row directly with a minimal store surface, instead of the
// whole Sidebar tree (which would drag in createSession/reorderSessions/
// workspaces/sandbox/etc. for no added bite -- same reasoning as
// tests/desktop-explorer-selection-dom.test.ts's scope note on mounting
// HighlightedLines instead of the whole ExplorerView).
export function SessionRow({
  session,
  dnd,
  roster,
  collapsed
}: {
  // The whole Agents list, in display order. The row's context menu offers a
  // LIST-scoped action (copy the peer table) next to its row-scoped ones, and
  // taking the roster as a prop means it is the SAME list the sidebar renders
  // -- reading the store again here would duplicate the `!supervisor` filter
  // and let the two drift.
  session: SessionRuntime
  dnd: RowDnd
  roster: readonly SessionRuntime[]
  // Sidebar folded to its rail: the row keeps its live signals (status dot,
  // team-lead laurel) and drops everything that needs width. The row is NOT
  // unmounted -- an unmounted row would take the operator's selection and the
  // in-flight confirm dialogs with it.
  collapsed: boolean
}): React.JSX.Element {
  const t = useT()
  const config = useDeck((s) => s.config!)
  const selectedId = useDeck((s) => s.selectedId)
  const maximizedId = useDeck((s) => s.maximizedId)
  const setSelected = useDeck((s) => s.setSelected)
  const setMaximized = useDeck((s) => s.setMaximized)
  const removeSession = useDeck((s) => s.removeSession)
  const renameSession = useDeck((s) => s.renameSession)
  const setColor = useDeck((s) => s.setColor)
  const setAutoResume = useDeck((s) => s.setAutoResume)
  const clearAttention = useDeck((s) => s.clearAttention)
  const showToast = useDeck((s) => s.showToast)
  const openDiff = useDeck((s) => s.openDiff)

  // Effective auto-resume: per-session override wins, else the global setting.
  const autoResumeOn = session.autoResume ?? config.autoResumeQuota

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Second-step dialog after deleting a worktree session: also remove its dir?
  const [confirmingWorktree, setConfirmingWorktree] = useState<{
    path: string
    branch: string
  } | null>(null)
  // Right-click menu anchor (viewport coords), or null when closed.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)

  const copyPeerId = (): void => {
    if (!session.peerId) return
    void navigator.clipboard.writeText(session.peerId)
    showToast('toast.peerIdCopied')
  }

  // Card c8ee5732: LIST-scoped, unlike copyPeerId -- the clicked row does not
  // matter, the whole roster is copied so a freshly spawned team-lead can be
  // handed its directory in one gesture. Empty when no peer has an id yet.
  const peerTable = formatPeerTable(roster, t('sidebar.peerTableYou'))
  const copyPeerTable = (): void => {
    if (!peerTable) return
    void navigator.clipboard.writeText(peerTable)
    showToast('toast.peerTableCopied')
  }

  const commit = (): void => {
    setEditing(false)
    if (draft.trim() && draft !== session.name) renameSession(session.id, draft.trim())
    else setDraft(session.name)
  }

  const className = [
    'row',
    selectedId === session.id ? 'row-selected' : '',
    dnd.dragId === session.id ? 'row-dragging' : '',
    dnd.overId === session.id && dnd.dragId !== session.id ? 'row-drag-over' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li
      className={className}
      // Folded, the name is gone from the strip, so the row itself carries it.
      title={collapsed ? session.name : undefined}
      // Draggable to reorder; disabled while renaming so the text input keeps
      // its normal selection/caret behaviour.
      draggable={!editing && !collapsed}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        dnd.onDragStart(session.id)
      }}
      onDragEnter={() => dnd.onDragEnter(session.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => dnd.onDrop(e, session.id)}
      onDragEnd={dnd.onDragEnd}
      onClick={() => setSelected(session.id)}
      // Folded, the row is a signal strip, not a command surface: the menu it
      // would open acts on things the rail cannot show (rename, peer table,
      // diff), so it stays behind the unfold.
      onContextMenu={(e) => {
        e.preventDefault()
        if (collapsed) return
        setSelected(session.id)
        setMenuPos({ x: e.clientX, y: e.clientY })
      }}
      onDoubleClick={(e) => {
        // Mirror the tile head: double-click toggles maximize. Ignore
        // double-clicks that land on a button/input (they own their gesture).
        if ((e.target as HTMLElement).closest('button, input')) return
        setSelected(session.id)
        setMaximized(maximizedId === session.id ? null : session.id)
      }}
    >
      {!collapsed && (
        <input
          type="color"
          className="swatch"
          value={session.color || '#4f86ff'}
          title={t('sidebar.sessionColour')}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => void setColor(session.id, e.target.value)}
        />
      )}
      <span
        className={`dot dot-${session.status}${session.needsAttention ? ' dot-attention' : session.rateLimited ? ' dot-limited' : session.activity === 'working' ? ' dot-thinking' : session.activity === 'unknown' ? ' dot-unknown' : ''}`}
        title={
          session.needsAttention
            ? t('status.needsAttention')
            : session.rateLimited
              ? t('status.rateLimited')
              : session.activity === 'working'
                ? t('status.thinking')
                : session.activity === 'unknown'
                  ? t('status.unknown')
                  : t(`status.${session.status}`)
        }
      />
      {/* The ROLE glyph (card b5ba8cac) does NOT land here, although a comment
          in this spot used to reserve the slot: measured on screen, a badge
          inserted between the dot and .row-main pushes the session name from
          x=111 to x=132 on role-bearing rows ONLY, which is the very ragged
          left edge card b0042a27 removed by pulling the laurel out of
          .row-name. It is rendered after .row-main instead, next to the
          laurel — see there for why that placement also serves the folded
          rail without a second rule. */}
      {!collapsed && (
        <div className="row-main">
          {editing ? (
            <input
              className="row-edit"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') {
                  setDraft(session.name)
                  setEditing(false)
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className="row-name"
              title={session.cwd}
              style={{ color: session.color || undefined }}
            >
              {session.name}
            </span>
          )}
          <span className="row-sub" title={session.cwd}>
            {session.worktree && (
              <span className="row-branch">
                {GLYPHS.git} {session.worktree.branch} ·{' '}
              </span>
            )}
            {session.peerId ??
              t('session.pending', { id: (session.sessionId || session.id).slice(0, 8) })}
          </span>
          {session.needsAttention && (
            <button
              type="button"
              className="row-attention"
              title={t('attention.dismiss')}
              onClick={(e) => {
                e.stopPropagation()
                void clearAttention(session.id)
              }}
            >
              {GLYPH_BADGES.warning} {t('attention.badge')}
            </button>
          )}
          {session.rateLimited && (
            <span className="row-quota">
              {autoResumeOn && session.resumeAt
                ? t('quota.resumeAt', { time: formatClock(session.resumeAt) })
                : t('quota.limited')}
            </span>
          )}
        </div>
      )}
      {/* Role mark (card b5ba8cac): what this agent DOES, read straight from
          the local SessionDef (no broker round-trip -- SessionRuntime extends
          SessionDef). It sits in the SAME right-hand badge column as the
          laurel, ahead of it, for one reason that covers both panel states:
          folded, .row-main is not rendered at all, so this exact DOM order
          collapses to dot -> role -> laurel with no conditional rule, while
          unfolded every name still starts at the same x. The two marks are
          independent dimensions -- a lead that also carries a role shows both,
          side by side. No role => nothing rendered, row unchanged. */}
      {roleGlyph(session.role) && (
        <span className="row-role" title={t('sidebar.roleTitle', { role: session.role ?? '' })}>
          {roleGlyph(session.role)}
        </span>
      )}
      {/* Team-lead mark: a badge of the ROW, anchored right of .row-main, not an
          ornament of the name -- inside .row-name it pushed lead names right and
          broke the left alignment of the list. */}
      {session.lead && (
        <span className="row-lead" title={t('sidebar.leadTitle')}>
          {GLYPH_BADGES.laurel}
        </span>
      )}
      {/* Row actions: dropped folded rather than shrunk. They are hover-revealed
          affordances acting on a row the rail no longer names; not rendering
          them also keeps them out of the tab order, which hiding them with
          `visibility` would not. */}
      {!collapsed && !editing && (
        <button
          className="row-btn"
          title={t('sidebar.renameTitle')}
          onClick={(e) => {
            e.stopPropagation()
            setDraft(session.name)
            setEditing(true)
          }}
        >
          {GLYPH_ACTIONS.edit}
        </button>
      )}
      {!collapsed && (
        <button
          className="row-btn"
          title={maximizedId === session.id ? t('common.restore') : t('common.maximize')}
          onClick={(e) => {
            e.stopPropagation()
            setSelected(session.id)
            setMaximized(maximizedId === session.id ? null : session.id)
          }}
        >
          {maximizedId === session.id ? GLYPH_ACTIONS.restore : GLYPH_ACTIONS.expand}
        </button>
      )}
      {!collapsed && (
        <button
          className="row-btn row-btn-danger"
          title={t('sidebar.removeTitle')}
          onClick={(e) => {
            e.stopPropagation()
            setConfirmingDelete(true)
          }}
        >
          {GLYPH_ACTIONS.close}
        </button>
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={t('confirm.deleteTitle')}
          message={t('confirm.deleteMessage', { name: session.name })}
          confirmLabel={t('common.delete')}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false)
            const wt = session.worktree
            void removeSession(session.id)
            // Worktree session: offer (never force) to also remove the dir.
            if (wt) setConfirmingWorktree(wt)
          }}
        />
      )}
      {confirmingWorktree && (
        <ConfirmDialog
          title={t('confirm.removeWorktreeTitle')}
          message={t('confirm.removeWorktreeMessage', {
            branch: confirmingWorktree.branch,
            path: confirmingWorktree.path
          })}
          confirmLabel={t('confirm.removeWorktreeConfirm')}
          onCancel={() => setConfirmingWorktree(null)}
          onConfirm={() => {
            const wt = confirmingWorktree
            setConfirmingWorktree(null)
            window.api.removeWorktree(wt.path).then(
              () => showToast('toast.worktreeRemoved'),
              // Dirty/locked worktree: git refuses -- surface it, never force.
              () => showToast('toast.worktreeRemoveFailed', 'info')
            )
          }}
        />
      )}
      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setMenuPos(null)}
          items={[
            {
              label: t('sidebar.copyPeerId'),
              onSelect: copyPeerId,
              disabled: !session.peerId
            },
            {
              label: t('sidebar.copyPeerTable'),
              onSelect: copyPeerTable,
              disabled: !peerTable
            },
            // Claude Code 2.1.235+ *may* own its own quota resume (card
            // fd1914cc), but that is not provable from here (the /config
            // toggle is conditional, consentGated, server-tracked) -- so the
            // global default is only gated OFF for this session while it
            // follows that default (`session.autoResume === undefined`);
            // this stays ACTIONABLE (never disabled) so the operator can
            // force it back on for this tile without restarting the app.
            session.claudeLaunch && session.autoResume === undefined
              ? {
                  label: t('sidebar.autoResumeNative'),
                  onSelect: () => void setAutoResume(session.id, true)
                }
              : {
                  label: autoResumeOn ? t('sidebar.autoResumeOff') : t('sidebar.autoResumeOn'),
                  onSelect: () => void setAutoResume(session.id, !autoResumeOn)
                },
            {
              label: (
                <>
                  {GLYPH_BADGES.laurel} {t('sidebar.setLead')}
                </>
              ),
              onSelect: () => void window.api.setLead(session.id),
              disabled: !!session.lead
            },
            {
              label: t('sidebar.viewDiff'),
              onSelect: () => openDiff({ dir: session.cwd, title: session.name })
            }
          ]}
        />
      )}
    </li>
  )
}

export function Sidebar(): React.JSX.Element {
  const t = useT()
  const allSessions = useDeck((s) => s.sessions)
  // The supervisor lives in the Home rail view, not in the Agents list.
  const sessions = allSessions.filter((s) => !s.supervisor)
  const config = useDeck((s) => s.config!)
  const createSession = useDeck((s) => s.createSession)
  const reorderSessions = useDeck((s) => s.reorderSessions)
  const openWorkspaces = useDeck((s) => s.openWorkspaces)
  const setSidebarWidth = useDeck((s) => s.setSidebarWidth)
  const collapsed = useDeck((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useDeck((s) => s.setSidebarCollapsed)
  const updateConfig = useDeck((s) => s.updateConfig)
  const sandboxStatus = useDeck((s) => s.sandboxStatus)
  const setView = useDeck((s) => s.setView)
  const showToast = useDeck((s) => s.showToast)
  const [createOpen, setCreateOpen] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const dnd: RowDnd = {
    dragId,
    overId,
    onDragStart: (id) => setDragId(id),
    onDragEnter: (id) => setOverId(id),
    onDragEnd: () => {
      setDragId(null)
      setOverId(null)
    },
    onDrop: (e, targetId) => {
      e.preventDefault()
      const sourceId = dragId
      setDragId(null)
      setOverId(null)
      if (!sourceId) return
      // Drop in the lower half of the target row -> insert after it (lets a row
      // be dragged to the very bottom).
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const after = e.clientY > rect.top + rect.height / 2
      const ids = sessions.map((s) => s.id)
      const next = moveBeside(ids, sourceId, targetId, after)
      if (next.some((id, i) => id !== ids[i])) void reorderSessions(next)
    }
  }

  // Drag the right edge to resize; persist the final width on mouse-up.
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const onMove = (ev: MouseEvent): void => setSidebarWidth(ev.clientX)
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      void updateConfig({ sidebarWidth: useDeck.getState().sidebarWidth })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    // Never mounted conditionally: folding is a width modifier on the SAME
    // element, otherwise the fold would take its own control away with it.
    <aside className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}>
      <header className="sidebar-head">
        {/* The fold control comes FIRST and keeps the header's own left padding,
            so it sits at the same pixel in both states -- it is the one thing
            this header is guaranteed to hold. */}
        <button
          className="icon-btn sidebar-fold"
          aria-expanded={!collapsed}
          title={collapsed ? t('sidebar.unfoldTitle') : t('sidebar.foldTitle')}
          aria-label={collapsed ? t('sidebar.unfoldTitle') : t('sidebar.foldTitle')}
          onClick={() => setSidebarCollapsed(!collapsed)}
        >
          {collapsed ? GLYPH_ACTIONS.panelUnfold : GLYPH_ACTIONS.panelFold}
        </button>
        {/* The header carries the fold control and NOTHING else (card 19f5ab5b).
            The workspace name it used to print was one composed string
            ("auto · <space> · <launch time>") already shown in full by the OS
            window title (App.tsx), so printing it here spent the panel's whole
            top row on a duplicate. Settings likewise has no control here: it
            lives in the app menu bar (Edit > Settings…, Ctrl/Cmd+,) so
            configuration is reachable from every view, not only from Agents. */}
      </header>

      {/* Creation + sandbox are decisions, not signals: they need their labels
          and their confirmations, so the rail drops them entirely. */}
      {!collapsed && (
        <div className="sidebar-actions">
          <button
            className="primary"
            onClick={() => void createSession({})}
            title={t('sidebar.addPeerTitle')}
          >
            {t('sidebar.addPeer')}
          </button>
          <button
            className="icon-btn"
            title={t('sidebar.advancedTitle')}
            onClick={() => setCreateOpen(true)}
          >
            <span className="sidebar-advanced-caret">{GLYPH_ACTIONS.forward}</span>
          </button>
          {/* Workspaces: an ACTION, so it belongs with the other actions rather
              than in the header, and it sits next to the sandbox jar because
              both answer "which environment am I in". */}
          <button
            className="icon-btn"
            title={t('sidebar.workspaces')}
            onClick={() => openWorkspaces(true)}
          >
            {GLYPH_BADGES.capsa}
          </button>
          {/* Sandbox pill (operator request 2c, option A): where agents will
              execute, one glance and one click. Grey = sandbox off (click opens
              the Docker view — ENABLING stays behind its trust-changing
              confirms there); amber stroke = enabled but the container is not
              running (click warms it up in the background); blue stroke = the
              container is live (click opens the Docker view to manage it). */}
          <button
            className={`icon-btn sandbox-pill${
              sandboxStatus?.enabled === true
                ? sandboxStatus.containerState === 'running'
                  ? ' pithos-live'
                  : ' pithos-stale'
                : ''
            }`}
            title={
              sandboxStatus?.enabled === true
                ? sandboxStatus.containerState === 'running'
                  ? t('sidebar.sandboxRunning')
                  : t('sidebar.sandboxStart')
                : t('sidebar.sandboxOff')
            }
            onClick={() => {
              if (sandboxStatus?.enabled === true && sandboxStatus.containerState !== 'running') {
                window.api
                  .sandboxWarmUp()
                  .then(() => showToast('toast.sandboxPreparing'))
                  .catch((e: unknown) =>
                    window.api.reportError('sandbox', `warm-up dispatch failed: ${String(e)}`)
                  )
                return
              }
              setView('sandbox')
            }}
          >
            <PithosGlyph needsAuth={sandboxStatus?.enabled === true && sandboxStatus.authed === false} />
          </button>
        </div>
      )}
      {/* The one child NOT guarded by `collapsed`, deliberately. CreateMenu
          opens from the advanced caret, which only exists unfolded, and it
          renders inside `.popover-backdrop` (`position: fixed; inset: 0`,
          z-index 60, `onMouseDown={onClose}` in CreateMenu.tsx) -- so it covers
          the fold button and any click that would fold the panel closes the
          popover first. `createOpen` and `collapsed` therefore cannot both be
          true; a guard here would be a condition that never fires, hiding this
          reasoning instead of stating it. */}
      {createOpen && <CreateMenu onClose={() => setCreateOpen(false)} />}

      <ul className="rows">
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} dnd={dnd} roster={sessions} collapsed={collapsed} />
        ))}
        {sessions.length === 0 && !collapsed && (
          <li className="rows-empty">{t('sidebar.noSessions')}</li>
        )}
      </ul>

      {/* Rendered ALWAYS and hidden by CSS when folded, unlike every other
          block above: MessageBar keeps its draft in a local `useState`, so
          unmounting it would throw away text the operator had typed, with no
          warning and nothing to undo. `display: none` keeps the component
          mounted (draft intact) and still takes its textarea out of the tab
          order. */}
      <MessageBar />

      {!collapsed && (
        <footer className="sidebar-foot" title={config.projectDir}>
          <span className="foot-label">{t('sidebar.project')}</span>
          <span className="foot-path">{config.projectDir}</span>
        </footer>
      )}

      {/* No resize handle on the rail: its width is a constant, and dragging it
          would overwrite the persisted open width with the rail's. */}
      {!collapsed && (
        <div className="sidebar-resize" onMouseDown={startResize} title={t('sidebar.resizeTitle')} />
      )}
    </aside>
  )
}
