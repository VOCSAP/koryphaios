import { useState } from 'react'
import type { SessionRuntime } from '@shared/types'
import { moveBeside } from '@shared/reorder'
import { useDeck } from '../store'
import { formatClock, useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu } from './ContextMenu'
import { CreateMenu } from './CreateMenu'
import { MessageBar } from './MessageBar'

/** Drag-and-drop wiring passed from the Sidebar down to each row. */
interface RowDnd {
  dragId: string | null
  overId: string | null
  onDragStart: (id: string) => void
  onDragEnter: (id: string) => void
  onDrop: (e: React.DragEvent, id: string) => void
  onDragEnd: () => void
}

function SessionRow({ session, dnd }: { session: SessionRuntime; dnd: RowDnd }): React.JSX.Element {
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
      // Draggable to reorder; disabled while renaming so the text input keeps
      // its normal selection/caret behaviour.
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        dnd.onDragStart(session.id)
      }}
      onDragEnter={() => dnd.onDragEnter(session.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => dnd.onDrop(e, session.id)}
      onDragEnd={dnd.onDragEnd}
      onClick={() => setSelected(session.id)}
      onContextMenu={(e) => {
        e.preventDefault()
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
      <input
        type="color"
        className="swatch"
        value={session.color || '#4f86ff'}
        title={t('sidebar.sessionColour')}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => void setColor(session.id, e.target.value)}
      />
      <span
        className={`dot dot-${session.status}${session.needsAttention ? ' dot-attention' : session.rateLimited ? ' dot-limited' : session.thinking ? ' dot-thinking' : ''}`}
        title={
          session.needsAttention
            ? t('status.needsAttention')
            : session.rateLimited
              ? t('status.rateLimited')
              : session.thinking
                ? t('status.thinking')
                : t(`status.${session.status}`)
        }
      />
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
          <span className="row-name" title={session.cwd} style={{ color: session.color || undefined }}>
            {session.lead && (
              <span title={t('sidebar.leadTitle')} className="row-lead">
                👑{' '}
              </span>
            )}
            {session.name}
          </span>
        )}
        <span className="row-sub" title={session.cwd}>
          {session.worktree && <span className="row-branch">⎇ {session.worktree.branch} · </span>}
          {session.peerId ??
            t('session.pending', { id: (session.sessionId || session.id).slice(0, 8) })}
        </span>
        {session.needsAttention && (
          <span className="row-attention">⏸ {t('attention.badge')}</span>
        )}
        {session.rateLimited && (
          <span className="row-quota">
            {autoResumeOn && session.resumeAt
              ? t('quota.resumeAt', { time: formatClock(session.resumeAt) })
              : t('quota.limited')}
          </span>
        )}
      </div>
      {!editing && (
        <button
          className="row-btn"
          title={t('sidebar.renameTitle')}
          onClick={(e) => {
            e.stopPropagation()
            setDraft(session.name)
            setEditing(true)
          }}
        >
          ✎
        </button>
      )}
      <button
        className="row-btn"
        title={maximizedId === session.id ? t('common.restore') : t('common.maximize')}
        onClick={(e) => {
          e.stopPropagation()
          setSelected(session.id)
          setMaximized(maximizedId === session.id ? null : session.id)
        }}
      >
        {maximizedId === session.id ? '⤡' : '⤢'}
      </button>
      <button
        className="row-btn row-btn-danger"
        title={t('sidebar.removeTitle')}
        onClick={(e) => {
          e.stopPropagation()
          setConfirmingDelete(true)
        }}
      >
        ✕
      </button>
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
              label: autoResumeOn ? t('sidebar.autoResumeOff') : t('sidebar.autoResumeOn'),
              onSelect: () => void setAutoResume(session.id, !autoResumeOn)
            },
            {
              label: `👑 ${t('sidebar.setLead')}`,
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
  const openSettings = useDeck((s) => s.openSettings)
  const openWorkspaces = useDeck((s) => s.openWorkspaces)
  const currentWorkspaceName = useDeck((s) => s.currentWorkspaceName)
  const setSidebarWidth = useDeck((s) => s.setSidebarWidth)
  const updateConfig = useDeck((s) => s.updateConfig)
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
    <aside className="sidebar">
      <header className="sidebar-head">
        {/* Show the current workspace name next to the workspaces icon; fall
            back to the app brand when no workspace is active. */}
        <span className="brand" title={t('app.brand')}>
          {currentWorkspaceName || t('app.brand')}
        </span>
        <button
          className="icon-btn"
          title={t('sidebar.workspaces')}
          onClick={() => openWorkspaces(true)}
        >
          🗂
        </button>
        <button className="icon-btn" title={t('sidebar.settings')} onClick={() => openSettings(true)}>
          ⚙
        </button>
      </header>

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
          ▾
        </button>
      </div>
      {createOpen && <CreateMenu onClose={() => setCreateOpen(false)} />}

      <ul className="rows">
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} dnd={dnd} />
        ))}
        {sessions.length === 0 && <li className="rows-empty">{t('sidebar.noSessions')}</li>}
      </ul>

      <MessageBar />

      <footer className="sidebar-foot" title={config.projectDir}>
        <span className="foot-label">{t('sidebar.project')}</span>
        <span className="foot-path">{config.projectDir}</span>
      </footer>

      <div className="sidebar-resize" onMouseDown={startResize} title={t('sidebar.resizeTitle')} />
    </aside>
  )
}
