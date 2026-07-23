// Runtime i18n for the main process. Pure (node fs/path only, no electron import)
// so it stays unit-testable under `bun test`. The electron-specific directory
// resolution (app dir / userData override) is wired in ipc.ts.
//
// Locale files live at desktop/locales/<lang>.json and are read at runtime, then
// merged user-override-on-top. EN_DEFAULTS below is the embedded last-resort
// fallback (DESIGN section 11) and MUST stay in sync with locales/en.json --
// the parity is asserted by tests/i18n.test.ts.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SUPPORTED_LOCALES = ['en', 'fr'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/**
 * Endonyms (native names) for each supported locale, shown verbatim in the
 * language picker -- the modern convention is to label a language in its own
 * tongue rather than translate it. English is the embedded base, so it is
 * always offered even without a shipped en.json.
 */
export const LOCALE_NATIVE_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
  fr: 'Français'
}

/** A selectable language: stable code + native display label. */
export interface LocaleOption {
  code: SupportedLocale
  label: string
}

/**
 * The languages offered in the settings picker, derived from the locale files
 * actually present in `dirs` (shipped + user-override). English is always
 * included (its dictionary is embedded as EN_DEFAULTS); any other supported
 * locale appears only once a `<code>.json` exists.
 */
export function availableLocales(dirs: string[]): LocaleOption[] {
  return SUPPORTED_LOCALES.filter(
    (code) => code === 'en' || dirs.some((dir) => existsSync(join(dir, `${code}.json`)))
  ).map((code) => ({ code, label: LOCALE_NATIVE_NAMES[code] }))
}

/** Embedded English base, mirror of locales/en.json (parity-tested). */
export const EN_DEFAULTS: Record<string, string> = {
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.create': 'Create',
  'common.delete': 'Delete',
  'common.close': 'Close',
  'common.browse': 'Browse…',
  'common.restore': 'Restore',
  'common.maximize': 'Maximize',

  'app.brand': 'Koryphaios',
  'app.loading': 'Loading…',

  'sidebar.settings': 'Settings',
  'sidebar.workspaces': 'Workspaces',
  'sidebar.addPeer': '＋ Add peer',
  'sidebar.addPeerTitle': 'Add in project dir',
  'sidebar.advancedTitle': 'Advanced: agent, args, presets, folder…',
  'sidebar.noSessions': 'No sessions',
  'sidebar.project': 'project',
  'sidebar.resizeTitle': 'Drag to resize',
  'sidebar.sessionColour': 'Session colour',
  'sidebar.renameTitle': 'Rename',
  'sidebar.removeTitle': 'Remove',
  'sidebar.copyPeerId': 'Copy peer id',
  'sidebar.autoResumeOn': 'Enable quota auto-resume',
  'sidebar.autoResumeOff': 'Disable quota auto-resume',

  'status.running': 'running',
  'status.starting': 'starting',
  'status.exited': 'exited',
  'status.thinking': 'thinking…',
  'status.rateLimited': 'usage limit reached',
  'session.pending': 'Session {id}',
  'quota.limited': 'usage limit reached',
  'quota.resumeAt': 'auto-resume at {time}',

  'confirm.deleteTitle': 'Delete session?',
  'confirm.deleteMessage':
    'Remove "{name}"? Its terminal is closed; the underlying Claude session can still be resumed later from history.',
  'confirm.closeTitle': 'Close session?',
  'confirm.closeMessage':
    'Close "{name}"? Its terminal stops; the underlying Claude session can still be resumed later from history.',
  'confirm.newClearTitle': 'Close all sessions?',
  'confirm.newClearMessage':
    'Close all peer terminals and return to an empty window? They are auto-saved and can be reopened later from Workspaces.',
  'confirm.newClearConfirm': 'Close all',
  'confirm.restoreLossTitle': 'Restore workspace?',
  'confirm.restoreLossMessage':
    'Restoring will close the current sessions and load this workspace instead. The current sessions are auto-saved and can be reopened later.',
  'confirm.deleteWorkspaceTitle': 'Delete workspace?',
  'confirm.deleteWorkspaceMessage':
    'Delete "{name}"? This removes the saved layout only; Claude session history is untouched.',

  'workspaces.title': 'Workspaces',
  'workspaces.save': 'Save',
  'workspaces.saveAs': 'Save as…',
  'workspaces.saveAsPrompt': 'Workspace name',
  'workspaces.restore': 'Restore',
  'workspaces.delete': 'Delete',
  'workspaces.empty': 'No saved workspaces yet.',
  'workspaces.current': 'current',
  'workspaces.locked': 'in use',
  'workspaces.pinned': 'pinned',
  'workspaces.sessions': '{n} sessions',
  'saveas.title': 'Save workspace as',
  'saveas.duplicate': 'A workspace with this name already exists',
  'banner.brokerDown': '⚠ Broker unreachable since {time}',
  'banner.retry': 'Retry',
  'banner.dismiss': 'Dismiss',
  'toast.workspaceSaved': 'Workspace saved',
  'toast.alreadyOpen': 'Session already open',
  'toast.peerIdCopied': 'peer id copied',

  'tile.expiredTitle': 'Session expired',
  'tile.expiredBody': 'Its transcript is gone. Start a new session with the same setup.',
  'tile.startNew': 'Start new',

  'settings.title': 'Settings',
  'settings.catGeneral': 'General',
  'settings.catAppearance': 'Appearance',
  'settings.catTerminal': 'Terminal',
  'settings.projectDir': 'Project directory',
  'settings.projectDirHelp': 'Default working directory for new peer terminals.',
  'settings.launchCommand': 'Launch command',
  'settings.launchCommandHelp':
    'Run in each terminal, with --session-id appended. Saved to the global launch config; a project .claude/claude-peers/config.json overrides it.',
  'settings.shellOverride': 'Shell override',
  'settings.shellPlaceholder': 'auto ($SHELL / powershell.exe)',
  'settings.shellHelp': 'Leave empty to auto-detect per OS.',
  'settings.interactiveShell': 'Interactive shell (load rc/profile for aliases)',
  'settings.displayMode': 'Display mode',
  'settings.fontSize': 'Font size',
  'settings.theme': 'Theme',
  'settings.themeDark': 'Dark',
  'settings.themeLight': 'Light',
  'settings.restoreSessions': 'Re-open saved sessions on launch',
  'settings.rememberScope': 'Remember shared scope secrets on this machine',
  'settings.rememberScopeHelp':
    'Stores a custom (shared) group secret encrypted via the OS keystore so its workspace can be restored without re-supplying the secret. Off = supply it via the launch argument each time.',
  'settings.autoResumeQuota': 'Auto-resume sessions when the usage limit resets',
  'settings.autoResumeQuotaHelp':
    'When a session hits Claude\'s usage limit, wait for the reset time printed on screen, then submit "continue" automatically. Overridable per session via its right-click menu.',
  'settings.language': 'Language',
  'settings.languageAuto': 'Auto (system)',
  'settings.glowColor': 'Glyph glow colour',
  'settings.glowReset': 'Default (gold)',
  'settings.glowHelp':
    'Luminous halo of the rail icons when an agent or the supervisor requires your attention.',
  'settings.palette': 'Session colour palette',
  'settings.paletteHelp':
    'Colours cycled through for new sessions. Each session can still be recoloured individually.',
  'settings.paletteAdd': '＋ Add colour',
  'settings.paletteReset': 'Reset to default',
  'settings.paletteRemove': 'Remove colour',

  'mode.1x1': '1×1 (carousel)',
  'mode.1x2': '1×2',
  'mode.2x2': '2×2',
  'mode.custom': 'Custom',

  'modebar.1x1Title': 'Carousel (one at a time)',
  'modebar.1x2Title': 'One row, two columns',
  'modebar.2x2Title': 'Two by two grid',
  'modebar.customTitle': 'Custom grid',
  'modebar.columns': 'Columns',
  'modebar.rows': 'Rows',
  'modebar.countOne': '{n} session',
  'modebar.countOther': '{n} sessions',

  'search.placeholder': 'Search open sessions…',
  'search.toggleTitle': 'Search across sessions (Ctrl+Shift+F)',
  'search.countOne': '{n} match',
  'search.countOther': '{n} matches',
  'search.noResults': "No matches in the open sessions' scrollback.",
  'search.jumpTitle': 'Double-click to jump to this match',
  'search.hint': 'Double-click a result to focus its tile and scroll the terminal to the match.',

  'message.placeholder': 'Message all peers in the group…',
  'message.send': 'Send',
  'message.sendTitle': 'Broadcast to all peers (Enter to send, Shift+Enter for a newline)',
  'toast.announceSent': 'Message sent to the group',
  'toast.announceNoPeers': 'No peers to receive the message',
  'toast.quotaResumed': 'Quota reset — "continue" sent automatically',

  'create.title': 'New peer session',
  'create.agent': 'Agent',
  'create.agentDefault': 'default (none)',
  'create.name': 'Name',
  'create.model': 'Model',
  'create.modelDefault': 'default',
  'create.extendedContext': 'Extended context (1M)',
  'create.extendedContextHelp':
    'Append [1m] to use the 1 million token context window. Supported on Opus and Sonnet, not Haiku.',
  'create.effort': 'Effort',
  'create.effortAuto': 'Auto',
  'create.effortFaster': 'Faster',
  'create.effortSmarter': 'Smarter',
  'create.extraArgs': 'Extra launch args',
  'create.extraArgsPlaceholder': 'e.g. --add-dir ..',
  'create.prompt': 'Initial prompt',
  'create.promptPlaceholder': 'e.g. Read PLAN.md and start task 2',
  'create.promptHelp':
    'Submitted to Claude as soon as the session opens (fresh launch only; never re-played on resume).',
  'create.announce': 'Join announcement',
  'create.announcePlaceholder': 'agent: …, model: …, effort: …',
  'create.announceHelp':
    "Broadcast to the group's peers once this session joins, with its peer_id. Edit freely.",
  'create.presets': 'Presets',
  'create.customColour': 'Custom colour',
  'create.colourTitle': 'Click to choose a custom colour',
  'create.advanced': 'Advanced',
  'create.workingFolder': 'Working folder',
  'create.workingFolderPlaceholder': '(project dir)',
  'create.workingFolderHelp':
    "Run this peer in another directory. It still joins this window's group; only its working directory changes. Use with care -- the peer can act on that folder.",

  'tile.fullscreenTitle': 'Double-click to toggle fullscreen',
  'tile.restartTitle': 'Restart peer',
  'tile.closeTitle': 'Close session',

  'area.emptyTitle': 'No peer terminals yet',
  'area.emptyBody':
    "Add a Claude Code peer session to dock it here. Each tile runs in a real terminal, scoped to this window's isolated group, so OAuth works normally.",
  'area.addTerminal': '＋ Add peer terminal',
  'area.restorePrevious': 'Restore previous session',
  'area.useTemplate': 'Use template',
  'area.openWorkspacesTitle': 'Open workspaces',

  'template.exportTitle': 'Export template',
  'template.name': 'Template name',
  'template.namePlaceholder': 'e.g. My team',
  'template.localCheckbox': 'Local template (this project)',
  'template.localHelp': 'Saved in this project: .claude/claude-peers/templates',
  'template.globalHelp': 'Saved globally, available to every project',
  'template.pickTitle': 'Use a template',
  'template.empty': 'No templates yet. Create one from File > Export template.',
  'template.use': 'Use template',
  'template.apply': 'Apply template',
  'template.delete': 'Delete template',
  'template.sessions': '{n} sessions',
  'template.source.global': 'global',
  'template.source.local': 'local',
  'toast.templateExported': 'Template exported',
  'toast.templateApplied': 'Template applied',
  'toast.templateDeleted': 'Template deleted',
  'confirm.applyTemplateTitle': 'Replace current sessions?',
  'confirm.applyTemplateMessage':
    'Applying this template closes the current sessions and opens the template instead. The current sessions are auto-saved and can be reopened later from Workspaces.',
  'confirm.deleteTemplateTitle': 'Delete template?',
  'confirm.deleteTemplateMessage':
    'Delete "{name}"? This removes the saved template file; running sessions are untouched.',

  'create.worktree': 'Worktree branch',
  'create.worktreePlaceholder': 'e.g. agent/{name} — empty = no worktree',
  'create.worktreeHelp':
    'Creates a fresh git worktree under .worktrees/ on this NEW branch and runs the session in it, so parallel agents never step on each other. Add .worktrees/ to your .gitignore.',
  'confirm.removeWorktreeTitle': 'Remove the worktree too?',
  'confirm.removeWorktreeMessage':
    'The session ran in worktree “{path}” (branch {branch}). Remove the directory? The branch and its commits are kept; git refuses if uncommitted changes remain.',
  'confirm.removeWorktreeConfirm': 'Remove worktree',
  'toast.worktreeRemoved': 'Worktree removed (branch kept)',
  'toast.worktreeRemoveFailed': 'Worktree kept: git refused (uncommitted changes?)',
  'common.edit': 'Edit…',
  'help.buttonTitle': 'Help assistant (right-click: options)',
  'help.title': 'Help assistant',
  'help.hint':
    'Ask about the app or about what you see on screen — e.g. "which roadmap item should I tackle next?". Read-only advisor: it cannot act.',
  'help.placeholder': 'Your question… (Enter to send)',
  'help.send': 'Send',
  'help.thinking': 'Thinking…',
  'help.failed': 'Help invocation failed: {error}',
  'help.model': 'Model: {model}',
  'help.hide': 'Hide the help button (re-enable in Settings)',
  'settings.helpButton': 'Show the floating "?" help button',
  'settings.helpModel': 'Help assistant & resume digest model',
  'settings.helpModelHelp':
    "Each question is a one-shot read-only inference with the active view's context — any catalog model (frontier CLI or local endpoint). Haiku is cheap and usually enough; note local endpoints cannot read the project files.",
  'settings.helpModelHint': "The assistant's model is picked in the Models category.",
  'settings.wandModel': 'Roadmap context-wand model',
  'settings.wandModelHelp':
    "Read-only inference drafting an item's context briefing (the operator reviews before saving). Haiku default.",
  'status.needsAttention': 'waiting for you',
  'attention.badge': 'needs you',
  'settings.notifyAttention': 'System notification when a session waits for your input',
  'settings.spawnMode': 'Supervisor agent spawns',
  'settings.spawnModeHandsFree': 'Hands-free',
  'settings.spawnModeHandsFreeHelp':
    'The supervisor spawns the agents you ask for, with no app-level confirmation. Every launch stays visible (tile + journal).',
  'settings.spawnModeTeamReview': 'Team review',
  'settings.spawnModeTeamReviewHelp':
    'The app shows you the full team plan before launching; one click approves it all.',
  'settings.spawnModeFullControl': 'Full control',
  'settings.spawnModeFullControlHelp':
    'Each agent is confirmed one by one before it launches. Most control, most clicks.',
  'sidebar.setLead': 'Designate as team-lead',
  'sidebar.leadTitle':
    'Team-lead: targeted app notices (dispatch, integrations) go to this session',
  'create.lead': 'Team-lead of this window',
  'create.leadHelp':
    'Targeted app notices (queue dispatch, integration notices) go to the team-lead. One per window; designating a new one demotes the previous.',
  'create.leadTaken': 'a team-lead already exists (checking moves the crown)',
  'nav.worktrees': 'Worktrees',
  'worktrees.title': 'Git worktrees',
  'worktrees.create': '＋ Create worktree',
  'worktrees.branchPlaceholder': 'new branch, e.g. agent/fix-login',
  'worktrees.empty':
    'No worktrees yet. Create one here or spawn a session with a worktree branch (advanced create menu).',
  'worktrees.main': 'main tree',
  'worktrees.orphan': 'orphan — no session',
  'worktrees.session': 'session: {name}',
  'worktrees.dirty': '{n} uncommitted change(s)',
  'worktrees.clean': 'clean',
  'worktrees.openSession': 'Open a session here',
  'worktrees.remove': 'Remove',
  'worktrees.copyPath': 'Copy path',
  'toast.worktreeCreated': 'Worktree created',
  'toast.pathCopied': 'Path copied',
  'nav.home': 'Home',
  'home.starting': 'Starting the supervisor session…',
  'home.body':
    'The supervisor pilots this window: it reads the roadmap, spawns briefed agent sessions (with profiles and worktrees) and coordinates them. It never codes itself.',
  'home.start': 'Start the supervisor',
  'home.error': 'Supervisor error: {error}',
  'nav.agents': 'Agents',
  'nav.browser': 'Browser',
  'browser.urlPlaceholder': 'URL — e.g. localhost:3000',
  'browser.loadFailed': 'This page could not be loaded.',
  'browser.reloadPage': 'Reload',
  'browser.back': 'Back',
  'browser.forward': 'Forward',
  'browser.reload': 'Reload (Shift-click: ignore cache)',
  'browser.pick': 'Pick a page element for the docked agent (Esc cancels)',
  'browser.devtools': "Open the page's DevTools",
  'browser.external': 'Open in the system browser',
  'browser.dockLabel': 'Docked agent',
  'browser.noDock': 'No docked agent',
  'browser.dockDetach': 'Undock (full-width browser)',
  'browser.backToAgents': 'Back to the Agents view',
  'browser.elementPrompt': 'On {url}, about the <{tag}> element ({w}x{h}px, selector: {selector}). ',
  'browser.elementPromptText': 'Visible text: "{text}". ',
  'toast.pickSent': "Element description pasted into the docked agent's prompt",
  'toast.pickCopied': 'No running docked agent — element description copied',
  'tile.browserTitle': 'Open the browser view with this agent',
  'browser.viewport': 'Simulated device size',
  'browser.viewportResponsive': 'Responsive (fill)',
  'browser.viewportContext': '[viewport: {w}x{h} – {name}] ',
  'browser.draw':
    'Annotate the page (draw, then 📸 sends a screenshot to the docked agent; Esc cancels)',
  'browser.drawSend': 'Send the annotated screenshot',
  'browser.drawClear': 'Clear the drawing',
  'browser.drawPrompt':
    'I annotated a screenshot of {url}: read the image file {path} to see the highlighted areas. ',
  'toast.drawSent': "Annotated screenshot pasted into the docked agent's prompt",
  'toast.drawCopied': 'No running docked agent — annotation prompt copied',
  'toast.drawFailed': 'Screenshot capture failed',
  'browser.modeWeb': 'Web page mode',
  'browser.modeWindow': 'OS window mirror mode',
  'browser.windowSelect': 'Choose a window…',
  'browser.windowRefresh': 'Refresh the window list and capture',
  'browser.windowEmpty':
    'Pick an OS window to mirror it here — then annotate it with ✏ and send the capture to the docked agent with 📸.',
  'browser.windowDrawPrompt':
    'I annotated a screenshot of the window "{title}": read the image file {path} to see the highlighted areas. ',
  'design.sourcePrefix': '[app: {source}] ',
  'nav.roadmap': 'Roadmap',
  'roadmap.title': 'Roadmap',
  'roadmap.add': '＋ Add item',
  'roadmap.empty':
    'The roadmap is empty. Add features, bugs, debt or ideas — agents can too, via their roadmap tools.',
  'roadmap.showArchived': 'Show archived',
  'roadmap.filterKind': 'Filter by kind',
  'roadmap.allKinds': 'All kinds',
  'roadmap.error': 'Roadmap error: {error}',
  'roadmap.kind.feature': 'Feature',
  'roadmap.kind.bug': 'Bug',
  'roadmap.kind.debt': 'Tech debt',
  'roadmap.kind.idea': 'Idea',
  'roadmap.kind.chore': 'Chore',
  'roadmap.priority.must': 'Must have',
  'roadmap.priority.should': 'Should have',
  'roadmap.priority.could': 'Could have',
  'roadmap.priority.wont': "Won't have",
  'roadmap.level.low': 'low',
  'roadmap.level.medium': 'medium',
  'roadmap.level.high': 'high',
  'roadmap.status.idea': 'idea',
  'roadmap.status.planned': 'planned',
  'roadmap.status.in_progress': 'in progress',
  'roadmap.status.done': 'done',
  'roadmap.status.archived': 'archived',
  'roadmap.value': 'value',
  'roadmap.effort': 'effort',
  'roadmap.fieldTitle': 'Title',
  'roadmap.fieldKind': 'Kind',
  'roadmap.fieldPriority': 'Priority',
  'roadmap.fieldStatus': 'Status',
  'roadmap.fieldDescription': 'Description',
  'roadmap.fieldRationale': 'Rationale (why it matters)',
  'roadmap.fieldTags': 'Tags',
  'roadmap.fieldTagsPlaceholder': 'comma, separated, tags',
  'roadmap.fieldContext': 'Context (agent briefing)',
  'roadmap.fieldContextPlaceholder':
    'Objective / Constraints / Pointers (files) / Acceptance criteria — everything the next agent cannot rediscover alone',
  'roadmap.wandTitle':
    'Draft with AI: a read-only haiku pass grounds the briefing in the project files (nothing is saved until you hit Save)',
  'roadmap.wandBusy': 'Drafting the briefing from the project files…',
  'roadmap.editTitle': 'Edit item',
  'roadmap.createTitle': 'New roadmap item',
  'roadmap.save': 'Save',
  'roadmap.create': 'Create',
  'roadmap.archive': 'Archive',
  'roadmap.restore': 'Restore',
  'roadmap.confirmArchiveTitle': 'Archive item?',
  'roadmap.confirmArchiveMessage':
    'Archive "{title}"? It disappears from default lists but can be restored later.',
  'roadmap.createdBy': 'created {date} by {name}',
  'roadmap.updatedBy': 'updated {date} by {name}',
  'roadmap.launchAgent': 'Launch an agent',
  'roadmap.launchAnnounce': 'works on roadmap item: {title}',
  'roadmap.importPlan': '📄 Import a plan…',
  'toast.planImportStarted':
    'Import agent started — it converts the plan into roadmap items, then closes',
  'toast.roadmapSaved': 'Roadmap item saved',
  'toast.roadmapArchived': 'Roadmap item archived',
  'tile.snippetsTitle': 'Insert a saved prompt (fills the input, does not send)',
  'snippets.title': 'Saved prompts',
  'snippets.hint':
    "Reusable prompts inserted into a session's input field — never sent automatically. Project prompts live in .claude/claude-peers/snippets and shadow a global prompt with the same name.",
  'snippets.empty': 'No saved prompts yet',
  'snippets.manage': 'Manage…',
  'snippets.new': '＋ New prompt',
  'snippets.name': 'Name',
  'snippets.scope': 'Scope',
  'snippets.text': 'Prompt',
  'snippets.textPlaceholder':
    'e.g. Pause the peers: update your summary and finish your current step, I am closing this session.',
  'snippets.save': 'Save',
  'snippets.confirmDeleteTitle': 'Delete prompt?',
  'snippets.confirmDeleteMessage': 'Delete "{name}"? The file is removed permanently.',
  'toast.snippetSaved': 'Prompt saved',
  'toast.snippetDeleted': 'Prompt deleted',
  'nav.inbox': 'Inbox',
  'inbox.title': 'Operator inbox',
  'inbox.close': 'Close',
  'inbox.empty':
    "No messages yet. Agents can write to you with send_message to 'operator' — questions, results, blockers.",
  'inbox.drafts': 'Questions to open in the graph',
  'inbox.openGraph': 'Open in graph',
  'inbox.hint': 'Read-only — answer via the megaphone at the bottom of the Agents sidebar.',
  'worktrees.diff': 'Diff',
  'sidebar.viewDiff': 'View diff',
  'diff.title': 'Diff — {name}',
  'diff.branchSection': 'Branch commits vs {base}',
  'diff.uncommittedSection': 'Uncommitted changes',
  'diff.noChanges': 'no changes',
  'diff.allClean': 'Working tree clean — nothing to review.',
  'diff.untracked': 'untracked',
  'diff.truncated': 'Diff truncated for display (the review agent reads the full one).',
  'diff.review': '🔎 Have an agent review this',
  'nav.git': 'Git',
  'git.title': 'Git — session changes',
  'git.readOnly': 'read-only — commits stay with the agents',
  'git.refresh': 'Refresh',
  'git.fullDiff': 'Back to the full diff',
  'nav.files': 'Files',
  'files.title': 'Files',
  'files.readOnly': 'read-only',
  'files.select': 'Select a file on the left to preview it.',
  'files.empty': 'empty',
  'files.binary': 'Binary file — no preview ({size} bytes).',
  'files.truncated': 'File truncated for display ({size} bytes on disk).',
  'files.selLines': 'lines {start}–{end}',
  'files.explain': '❓ Explain',
  'files.createTask': '🗺 Create a task',
  'files.explainQuestion': 'Explain this code ({file}, lines {start}-{end}).',
  'files.taskTitle': 'Refactor {file}',
  'files.taskContext': 'Code selected in the Files view — `{file}` lines {start}-{end}:',
  'help.detachSelection': 'Detach the code selection',
  'toast.reviewStarted': 'Review agent started — it reports to the team-lead when one is set',
  'nav.journal': 'Journal',
  'journal.title': 'Activity journal',
  'journal.allKinds': 'All events',
  'journal.export': 'Export…',
  'journal.empty': 'Nothing yet — spawns, exits, quota episodes, announces and worktree operations of this window will appear here.',
  'journal.kind.session': 'session',
  'journal.kind.quota': 'quota',
  'journal.kind.attention': 'attention',
  'journal.kind.worktree': 'worktree',
  'journal.kind.announce': 'announce',
  'journal.kind.dispatch': 'dispatch',
  'journal.kind.review': 'review',
  'journal.kind.checkpoint': 'checkpoint',
  'journal.kind.graph': 'graph',
  'journal.kind.error': 'error',
  'toast.journalExported': 'Journal exported',
  'roadmap.queueSection': 'Dispatch queue',
  'roadmap.queueAdd': '⏳ Queue for dispatch',
  'roadmap.queueRemove': 'Remove from queue',
  'roadmap.wf.title': 'Workflow',
  'roadmap.wf.hint': 'Drag roadmap cards here — agents process the chain left to right.',
  'roadmap.wf.collapse': 'Collapse the workflow lane',
  'roadmap.wf.expand': 'Expand the workflow lane',
  'roadmap.wf.linkHint':
    'Release on a card to make it depend on this one; release on empty space to create a new dependent item.',
  'roadmap.wf.violationOrder':
    '"{item}" is scheduled before its dependency "{dep}": reorder the queue or remove the dependency.',
  'roadmap.wf.violationMissing': 'Dependencies neither scheduled before this item nor done: {list}',
  'roadmap.wf.depLabel': '"{item}" depends on "{dep}".',
  'roadmap.wf.removeDep': 'Remove dependency',
  'roadmap.wf.createHere': 'Create a roadmap item here',
  'roadmap.dispatchFirst': '▶ Send first to team-lead',
  'roadmap.dispatchNoLeadHint':
    'Designate a team-lead (👑 in the Agents sidebar) to dispatch queued items.',
  'toast.dispatched': 'Item sent to the team-lead',
  'toast.dispatchNoLead': 'No team-lead — designate one first (👑)',
  'toast.dispatchFailed': 'Dispatch failed (empty queue or broker unreachable)',
  'roadmap.confirmDoneTitle': 'Mark as done?',
  'roadmap.confirmDoneMessage':
    'Mark "{title}" as done? Agents will no longer pick it up.',
  'roadmap.confirmDone': 'Mark done',
  'roadmap.lockedHint': 'An agent is actively working on this item (locked)',
  'roadmap.lockedSince': 'Locked by {name} since {date}',
  'roadmap.dependsOn': 'Depends on',
  'roadmap.stop': '⏹ Stop',
  'roadmap.confirmStopTitle': 'Stop work on this item?',
  'roadmap.confirmStopMessage':
    'Agents will be told to stop working on "{title}". The item is unlocked and returns to planned.',
  'roadmap.prioPick': 'click to change priority',
  'roadmap.menuEdit': '✏️ Edit…',
  'roadmap.menuQueue': '⏳ Add to dispatch queue',
  'roadmap.menuAssign': '▶ Process now…',
  'roadmap.menuDelete': '🗑 Delete (archives)',
  'roadmap.assignTitle': 'Process now',
  'roadmap.assignHint':
    'Send "{title}" to a live agent (targeted announce), or spawn a fresh one on it.',
  'roadmap.assignNoAgents': 'No live agent with a resolved peer_id — spawn a new one.',
  'roadmap.assignNew': '＋ New agent on this item…',
  'toast.assignSent': 'Item sent to the agent (moved to in progress)',
  'toast.assignFailed': 'Assignment failed (peer unreachable or broker down)',
  'toast.stopSupervisor': 'Stop routed through the supervisor — it will report back to your inbox',
  'toast.stopBroadcast': 'Stop broadcast to the group',
  'toast.stopNoPeers': 'Item unlocked (no active peer to notify)',
  'toast.stopFailed': 'Stop failed (item not found or broker unreachable)',
  'help.digestTitle': 'Resume digest — where things stand and what to do next',
  'help.digestQuestion': '📋 Resume digest',
  'composer.new': '＋ New template',
  'composer.edit': 'Edit',
  'composer.duplicate': 'Duplicate',
  'composer.createTitle': 'New template',
  'composer.editTitle': 'Edit template',
  'composer.templateName': 'Template name',
  'composer.name': 'session name',
  'composer.worktree': 'Worktree branch (fresh)',
  'composer.addSession': '＋ Add a session',
  'composer.save': 'Save template',
  'toast.templateSaved': 'Template saved',
  'nav.graph': 'Graph',
  'graph.title': 'Graph chats',
  'graph.defaultName': 'new graph',
  'graph.saveFailed': 'Graph could not be saved',
  'graph.newGraph': '＋ New',
  'graph.empty': 'No graph yet — create one and add a root node.',
  'graph.confirmDeleteTitle': 'Delete this graph?',
  'graph.confirmDeleteMessage': 'All its nodes will be deleted. This cannot be undone.',
  'graph.newRoot': '＋ Root node',
  'graph.nodeUser': 'you',
  'graph.selectHint':
    'Select a node to act on it. Shift-click for multi-selection, drag to move, wheel to zoom.',
  'graph.multiSelected': '{count} nodes selected',
  'graph.fromSelection': '＋ Node from selection',
  'graph.fromSelectionHint':
    'Creates a prompt node with the selected nodes as parents — their histories are compiled as a common trunk plus one labeled section per branch.',
  'graph.reply': 'Reply',
  'graph.connect': 'Connect parent',
  'graph.connectHint': 'Click the node to add as a parent (cycles are refused).',
  'graph.inspect': 'Inspect context',
  'graph.inspectorTitle': 'Compiled context (sent as system side)',
  'graph.inspectorPrompt': "Prompt (the node's message)",
  'graph.promptPlaceholder': 'Your message… (what if…? go deeper on…)',
  'graph.targets': 'Inference targets',
  'graph.modelDefault': 'default model',
  'graph.battle': 'Battle mode (judge node merges the answers)',
  'graph.battleHint':
    'Each checked CLI answers independently, then a judge node compares the anonymized answers and produces the merged one.',
  'graph.judge': 'Judge (claude)',
  'graph.infer': '▶ Infer',
  'graph.running': 'running…',
  'graph.error': 'inference failed',
  'graph.leafOnly': 'Only leaf nodes can be deleted.',
  'graph.cycleRefused': 'Refused: this connection would create a cycle.',
  'graph.zoomIn': 'Zoom in',
  'graph.zoomOut': 'Zoom out',
  'graph.fitView': 'Fit view',
  'graph.arrange': 'Auto-arrange nodes on the grid (by hierarchy level)',
  'graph.timeline': 'Timeline',
  'graph.timelineEmpty': 'No node yet.',
  'models.pin': 'Pin to favorites',
  'models.unpin': 'Unpin from favorites',
  'models.none':
    'No provider available — install claude / codex / gemini, or add a local endpoint in Settings.',
  'models.noFavorites': 'No favorites yet — expand a provider and star a model.',
  'models.local': 'local',
  'settings.catModels': 'Models',
  'settings.modelsDetection': 'Detected CLIs',
  'settings.modelsDetectionHelp':
    'A provider is offered in the model pickers only when its CLI is installed. Frontier model lists are curated in the app; local endpoints below are discovered dynamically.',
  'settings.modelsRefresh': 'Re-detect CLIs and endpoints',
  'settings.localProviders': 'Local model endpoints',
  'settings.localProvidersHelp':
    'OpenAI-compatible endpoints (Ollama, LiteLLM, vLLM…). Models are listed automatically via /v1/models (or Ollama /api/tags).',
  'settings.providerName': 'name',
  'settings.providerKey': 'API key (optional)',
  'settings.providerKeyClear': 'Forget the stored key',
  'settings.providerModels': '{count} model(s)',
  'settings.addProvider': '＋ Add an endpoint',
  'companion.title': 'Companion',
  'companion.hint':
    'Access this window from your phone, on the local network only. The QR code is only valid for this app launch — closing the app cuts the access.',
  'companion.start': 'Start mobile access',
  'companion.stop': 'Stop',
  'companion.scanHint': 'Scan this QR code with the phone camera (same Wi-Fi network).',
  'companion.certWarn':
    'The browser will show a certificate warning on first visit (local self-signed certificate): accept it, it is generated by this app.',
  'companion.paired':
    'Device connected ({count} client(s)). The QR was consumed — restart the access to pair another device.',
  'companion.devices': 'Paired devices',
  'companion.noDevices': 'No paired device.',
  'companion.revoke': 'Revoke',
  'companion.revokeAll': 'Revoke all',
  'companion.reconnecting': 'Reconnecting to the host…',
  'companion.hostGone': 'Host disconnected',
  'companion.hostGoneHint':
    'The app on the PC is closed or unreachable. Relaunch it, click “Companion” and re-scan the QR code.',
  'companion.retry': 'Retry',
  'mobile.more': 'More',
  'mobile.paste': 'Paste',
  'mobile.pasteDenied': 'Clipboard unavailable',
  'mobile.roadmapEmpty': 'No card in this column',
  'mobile.basketHint': 'Drop here:',
  'mobile.moved': 'Card moved',
  'mobile.undo': 'Undo',
  'mobile.moveTo': 'Move to…',
  'mobile.lift': 'Lift'
}

/**
 * Resolve the effective locale: an explicit `en`/`fr` config wins; anything else
 * (empty = "auto", or an unsupported tag) falls back to the OS locale, mapping
 * any `fr*` tag to French and everything else to English.
 */
export function resolveLocale(configLocale: string, osLocale: string): SupportedLocale {
  if (configLocale === 'en' || configLocale === 'fr') return configLocale
  return osLocale.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

function readDictFile(dir: string, lang: string): Record<string, string> | null {
  try {
    const file = join(dir, `${lang}.json`)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return null
  } catch {
    // Malformed JSON / unreadable file -> ignore, embedded defaults stand in.
    return null
  }
}

/**
 * Build the dictionary for `lang`, layered low-to-high:
 *   EN_DEFAULTS (embedded) < shipped en.json < shipped <lang>.json
 *               < user en.json < user <lang>.json
 * `dirs` is ordered shipped-first, user-override-last. Missing/broken files are
 * skipped so a key always resolves (eventually to the embedded English value).
 */
export function loadDict(lang: string, dirs: string[]): Record<string, string> {
  const dict: Record<string, string> = { ...EN_DEFAULTS }
  // For a non-English locale, layer English files first as the fallback base,
  // then the target language on top so its keys win.
  const langs = lang === 'en' ? ['en'] : ['en', lang]
  for (const l of langs) {
    for (const dir of dirs) {
      const fileDict = readDictFile(dir, l)
      if (fileDict) Object.assign(dict, fileDict)
    }
  }
  return dict
}

/**
 * Look up `key` and interpolate `{name}` placeholders from `params`. A missing
 * key returns the key verbatim; a placeholder with no matching param is left
 * untouched (never prints "undefined").
 */
export function t(
  dict: Record<string, string>,
  key: string,
  params?: Record<string, string | number>
): string {
  const template = dict[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  )
}
