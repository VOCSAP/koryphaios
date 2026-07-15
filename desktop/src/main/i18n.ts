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

  'app.brand': 'Claude Peers Deck',
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
  'create.promptPlaceholder': 'e.g. Read PLAN-v0.4.md and start C2',
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
  'settings.helpModel': 'Help assistant model',
  'settings.helpModelHelp':
    "Each question is a one-shot `claude -p` call with the active view's context. Haiku is cheap and usually enough.",
  'nav.home': 'Home',
  'home.starting': 'Starting the supervisor session…',
  'home.body':
    'The supervisor pilots this window: it reads the roadmap, spawns briefed agent sessions (with profiles and worktrees) and coordinates them. It never codes itself.',
  'home.start': 'Start the supervisor',
  'home.error': 'Supervisor error: {error}',
  'nav.agents': 'Agents',
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
  'toast.roadmapSaved': 'Roadmap item saved',
  'toast.roadmapArchived': 'Roadmap item archived'
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
