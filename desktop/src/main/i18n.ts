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
  "notifications.scanToPair": "Scan this with your phone, or open the link and press Start:",
  "notifications.inviteBot": "First, invite the bot to a private server you own — it cannot message you otherwise:",
  "notifications.inviteLink": "Open the invite",
  "notifications.linkTitle": "Use the same identity on another PC",
  "notifications.linkExport": "Show the link code",
  "notifications.linkHide": "Hide",
  "notifications.linkApply": "Link this PC",
  "notifications.linkPaste": "Paste the code shown on the other PC",
  "notifications.linkWarn": "This code carries your operator identity. Show it only to your own second machine, and close it right after.",
  "notifications.linkDone": "This PC now shares your identity — nothing to re-pair on your phone.",
  "notifications.linkFailed": "That code is not a valid identity.",
  "settings.mobileApprovals": "Remote approvals (answer a waiting session from your phone)",
  "settings.mobileApprovalsHelp": "Off by default: turning it on sends the question outside this machine.",
  "notifications.title": "Notification channels",
  "notifications.connect": "Connect",
  "notifications.disconnect": "Disconnect",
  "notifications.connected": "Connected",
  "notifications.starting": "Configured, starting…",
  "notifications.notConnected": "Not connected",
  "notifications.paired": "paired",
  "notifications.tokenPlaceholder": "Paste the bot token",
  "notifications.token.telegram": "Telegram bot token",
  "notifications.token.discord": "Discord bot token",
  "notifications.help.telegram": "Create a bot with @BotFather (/newbot) and paste the token it gives you.",
  "notifications.help.discord": "Developer Portal → your app → Bot → Reset Token. Leave Interactions Endpoint URL empty, and invite the bot to a private server so it can send you a DM.",
  "notifications.pair.telegram": "Send this code to your bot with /start to finish pairing:",
  "notifications.pair.discord": "Send this code to your bot in a direct message to finish pairing:",
  "notifications.pair.ntfy": "Scan this code with the Parastatès app.",
  "notifications.server.ntfy": "ntfy server",
  "notifications.tokenOptional": "Optional — leave empty for an open server",
  "notifications.token.ntfy": "ntfy access token",
  "notifications.help.ntfy":
    "The relay that carries the notifications. ntfy.sh works as-is; a self-hosted server keeps the questions on your own infrastructure. An access token is what keeps your topics private — strongly recommended on a shared server.",
  "notifications.mobileWarn":
    "This code carries your notification topics and access token: whoever photographs it can read your questions and answer them. Scan it with your phone, then close it.",
  "notifications.pairDone": "Done",
  "notifications.disabledHint": "Enable remote approvals above to connect a channel.",
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.create': 'Create',
  'common.delete': 'Delete',
  'common.close': 'Close',
  'common.browse': 'Browse…',
  'common.restore': 'Restore',
  'common.maximize': 'Maximize',


  'sidebar.workspaces': 'Workspaces',
  'sidebar.addPeer': '＋ Add peer',
  'sidebar.addPeerTitle': 'Add in project dir',
  'sidebar.advancedTitle': 'Advanced: agent, args, presets, folder…',
  'sidebar.noSessions': 'No sessions',
  'sidebar.project': 'project',
  'sidebar.resizeTitle': 'Drag to resize',
  'sidebar.foldTitle': 'Fold the panel to its rail',
  'sidebar.unfoldTitle': 'Unfold the panel',
  'sidebar.sessionColour': 'Session colour',
  'sidebar.renameTitle': 'Rename',
  'sidebar.removeTitle': 'Remove',
  'sidebar.copyPeerId': 'Copy peer id',
  'sidebar.copyPeerTable': 'Copy peer table',
  'sidebar.peerTableYou': '(you)',
  'sidebar.autoResumeOn': 'Enable quota auto-resume',
  'sidebar.autoResumeOff': 'Disable quota auto-resume',
  'sidebar.autoResumeNative':
    "Force quota auto-resume (the global setting doesn't apply to this Claude session)",

  'status.running': 'running',
  'status.starting': 'starting',
  'status.exited': 'exited',
  'status.thinking': 'thinking…',
  'status.unknown': 'activity unknown',
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
  'banner.brokerDown': 'Broker unreachable since {time}',
  'banner.retry': 'Retry',
  'banner.dismiss': 'Dismiss',
  'toast.workspaceSaved': 'Workspace saved',
  'toast.nothingToSave': 'Nothing to save',
  'toast.nothingToRestore': 'This workspace has no sessions to restore',
  'toast.alreadyOpen': 'Session already open',
  'toast.peerIdCopied': 'peer id copied',
  'toast.peerTableCopied': 'peer table copied',

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
  'settings.rememberScope': 'Remember shared scope secrets on this machine',
  'settings.rememberScopeHelp':
    'Stores a custom (shared) group secret encrypted via the OS keystore so its workspace can be restored without re-supplying the secret. Off = supply it via the launch argument each time.',
  'settings.autoResumeQuota': 'Auto-resume sessions when the usage limit resets',
  'settings.autoResumeQuotaHelp':
    'Does not apply to Claude Code sessions -- their resume is handled by the CLI itself, not this setting, and on the default path the Deck also stops showing their quota status anywhere (limit reached / resume time, including on mobile). Still applies to other CLIs: waits for the reset time printed on screen, then submits "continue" automatically. Overridable per session via its right-click menu, including forcing it back on for a Claude Code tile.',
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
  'area.spawning': 'The agent is starting…',
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
  'template.manage': 'Manage templates',
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
  'attention.dismiss': 'Dismiss (mark as no longer waiting)',
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
  'settings.joinAnnounceLevel': 'Peer-join announcement',
  'settings.joinAnnounceLevelOff': 'Off',
  'settings.joinAnnounceLevelOffHelp': 'No announcement when a new peer joins the group.',
  'settings.joinAnnounceLevelLead': 'Lead only',
  'settings.joinAnnounceLevelLeadHelp':
    'Only the active team-lead (or supervisor if none) is told a new peer joined.',
  'settings.joinAnnounceLevelAll': 'Everyone',
  'settings.joinAnnounceLevelAllHelp': 'Every active peer in the group is told a new peer joined.',
  'sidebar.setLead': 'Designate as team-lead',
  'sidebar.leadTitle':
    'Team-lead: targeted app notices (dispatch, integrations) go to this session',
  // ONE parameterised key rather than one label per role (card b5ba8cac): the
  // role is a free-text kebab identifier the create dialog already shows RAW,
  // and an operator-typed role through "Other…" could never have a key at all.
  // Translating six of them and leaving the seventh untranslated would be the
  // inconsistency; the tooltip names the role exactly as it was chosen.
  'sidebar.roleTitle': 'Role: {role}',
  'create.lead': 'Team-lead of this window',
  'create.leadHelp':
    'Targeted app notices (queue dispatch, integration notices) go to the team-lead. One per window; designating a new one demotes the previous.',
  'create.leadTaken': 'a team-lead already exists (checking moves the crown)',
  'create.role': 'Role',
  'create.roleNone': 'no role',
  'create.roleOther': 'Other…',
  'create.rolePlaceholder': 'e.g. data-engineer',
  'create.roleAdd': 'Add this role to the list',
  'create.roleShort': 'Optional. Remembered for next time.',
  'create.roleHelp':
    'What this agent does. Optional, visible to the other peers, and remembered for next time. Checking the team-lead box above suggests "team-lead" here; the two stay independent.',
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
  'nav.sandbox': 'Docker',
  'sandbox.title': 'Sandbox (Docker)',
  'sandbox.refresh': 'Refresh',
  'sandbox.mode': 'Sandbox mode — this project',
  'sandbox.enable': 'Enable sandbox',
  'sandbox.disable': 'Disable sandbox',
  'sandbox.engineOk': 'Engine: {engine} {version}',
  'sandbox.engineDown': 'Engine installed but not running — start Docker Desktop (or the podman machine).',
  'sandbox.engineMissing': 'No container engine detected.',
  'sandbox.installHint':
    'Install Docker Desktop (docs.docker.com/get-docker) or Podman Desktop (podman-desktop.io), then Refresh.',
  'sandbox.container': 'Container:',
  'sandbox.state.running': 'running',
  'sandbox.state.stopped': 'stopped',
  'sandbox.state.missing': 'not created yet',
  'sandbox.ports': 'published ports:',
  'sandbox.portsPlaceholder': '3000, 5173 (empty = publish none)',
  'sandbox.portsSave': 'Save ports',
  'sandbox.portsHint':
    'Published to 127.0.0.1 at container create — a rebuild applies changes. The defaults are the same for every project, so a second sandboxed project must use different ports (or none).',
  'sandbox.blockedLive': 'Sessions are running — close them before changing the sandbox.',
  'sandbox.forceClose': 'Force close ({n})',
  'sandbox.auth': 'Authentication (shared volume)',
  'sandbox.reauth': 'Re-authenticate',
  'sandbox.reauthBuildFirst': 'Build the image and sign in',
  'sandbox.reauthBlocked':
    'Signing in runs the CLI in a throwaway container built from the SHARED image: build it once (Image card above) and it serves every project.',
  'sandbox.authOk': 'connected',
  'sandbox.authMissing': 'not connected',
  'sandbox.railNeedsAuth': 'sign-in required',
  'sandbox.authUnknown': 'unknown (image not built)',
  'sandbox.authVolumeHint':
    'One login covers every sandbox container, in every project: credentials live in the kory-claude-auth volume, never on this machine. Signing in needs no project container.',
  'sandbox.containers': 'Sandbox containers (all projects)',
  'sandbox.containerProject': "This project's container",
  'sidebar.sandboxOff':
    'Sandbox is off for this project. Click opens the Docker view (enabling is confirmed there).',
  'sidebar.sandboxStart': 'Sandbox on, container stopped. Click starts the container in the background.',
  'sidebar.sandboxRunning': 'Agents execute inside the Docker container. Click opens the Docker view.',
  'sandbox.containerProjectNone':
    'No container yet: it is created on the first agent, or right now with Prepare.',
  'sandbox.containerProjectDisabled':
    'Sandbox mode is off for this project. An existing container would still show here; enable the mode to create one.',
  'sandbox.containersLoading': 'Querying the container engine…',
  'sandbox.containerPrepare': 'Prepare the container',
  'toast.sandboxPreparing': 'Container preparation started in the background',
  'sandbox.empty':
    "No sandbox container on this machine yet. Enable the mode and spawn a session, or use Re-authenticate to create this project's container.",
  'sandbox.current': 'this project',
  'sandbox.start': 'Start',
  'sandbox.stop': 'Stop',
  'sandbox.rebuild': 'Rebuild',
  'sandbox.remove': 'Remove',
  'sandbox.authDialogTitle': 'Sandbox — sign in to Claude',
  'sandbox.authIntro':
    "First use of the sandbox: the container needs its own Claude login (stored in the shared auth volume, not on this machine). Next opens a terminal inside the container — follow the CLI's login flow (open the URL, paste the code). Agents stay blocked until the login succeeds.",
  'sandbox.authNext': 'Next',
  'sandbox.authStarting': 'Starting…',
  'sandbox.authWait':
    "Complete the login below, THEN the CLI's onboarding (theme, confirmations) through to its final screen — this window closes by itself once onboarding is done. Closed too early, every agent would ask to sign in again.",
  'sandbox.authOpenUrl': 'Open the sign-in link',
  'sandbox.authCopyUrl': 'Copy the link',
  'sandbox.authUrlChars': '{n} characters',
  'sandbox.authClipboardHint':
    'Ignore the CLI\'s own "press c to copy": it runs inside the container, so its "Copied!" never reaches your clipboard. Use the buttons above, or select the text and press Ctrl+C.',
  'confirm.sandboxOnTitle': 'Enable sandbox mode?',
  'confirm.sandboxOnMessage':
    "New sessions will run inside this project's Docker container (the project folder stays mounted read-write; the rest of this machine is out of reach). Existing terminals are not moved.",
  'confirm.sandboxOnConfirm': 'Enable',
  'confirm.sandboxOffTitle': 'Disable sandbox mode?',
  'confirm.sandboxOffMessage':
    'New sessions will run directly on this machine again. The container is kept (even stopped) until you remove it in the Docker view.',
  'confirm.sandboxOffConfirm': 'Disable',
  'confirm.sandboxRemoveTitle': 'Remove this container?',
  'confirm.sandboxRemoveMessage':
    '{name} will be deleted along with everything installed inside it (the auth volume and the project folder are kept). This cannot be undone.',
  'confirm.sandboxRemoveConfirm': 'Remove',
  'toast.sandboxOn': 'Sandbox mode enabled',
  'toast.sandboxOff': 'Sandbox mode disabled',
  'toast.sandboxAuthDone': 'Sandbox signed in',
  'toast.authUrlCopied': 'Sign-in link copied',
  'toast.sandboxAction': 'Done',
  'sandbox.workMode': 'Work mode:',
  'sandbox.workMode.mount': 'Mount the project',
  'sandbox.workMode.copy': 'Ephemeral copy',
  'sandbox.workMode.mountHelp':
    'Agents edit your real project folder; the sandbox protects the rest of the machine.',
  'sandbox.workMode.copyHelp':
    'Agents work in a throwaway clone; your real folder is untouchable and work leaves through git.',
  'sandbox.bridge': 'Broker bridge:',
  'sandbox.bridgeOk': 'reachable',
  'sandbox.bridgeKo': 'unreachable',
  'sandbox.bridgeUnknown': 'not tested',
  'sandbox.bridgeRetest': 'Re-test',
  'sandbox.bridgeHint':
    'Sessions in the container cannot reach the broker: peer messaging and the roadmap will be offline. On a native Linux engine, bind the broker beyond loopback (CLAUDE_PEERS_BIND_HOST=0.0.0.0 with a broker_token).',
  'sandbox.drift': 'image is {n} day(s) newer',
  'sandbox.driftHint':
    'The image was rebuilt after this container was created — Rebuild to pick it up (everything installed by hand inside is lost).',
  'sandbox.protectionNotApplicable':
    'Not applicable in copy mode (the mounted tree is an ephemeral clone, not host-executed).',
  'sandbox.protection': 'protected paths:',
  'sandbox.protectionApplied': '{n} path(s) mounted read-only',
  'sandbox.protectionSkipped': '{n} not protected',
  'sandbox.protectionSkippedHint':
    'Paths this policy would normally protect but did not find on disk (a fresh .git, no .vscode, etc.) — not shown to the agent, by design.',
  'sandbox.protectionRebuildHint':
    'This container predates the read-only path protection (or the policy grew since it was created) — Rebuild to apply it.',
  'sandbox.sharedRunDirRebuildHint':
    'This container predates the per-project isolation fix and still shares its launch-script directory with other projects — Rebuild to apply it.',
  'sandbox.blockedRunning': 'A sandbox container is running — stop it first.',
  'sandbox.copy': 'Ephemeral copy',
  'sandbox.copyHint':
    'A local git clone of the project, mounted instead of the real folder. Agents commit here and push the branch back to your repo; the clone can be thrown away at any time.',
  'sandbox.copyDir': 'Clone:',
  'sandbox.copyIgnored': 'Extra files to copy in (one glob per line):',
  'sandbox.copyIgnoredPlaceholder': 'PLAN-*.md\ntask_plan.md\nnotes/**',
  'sandbox.copySaveGlobs': 'Save globs',
  'sandbox.copyDenyHint':
    'Secrets and bulk are never copied, whatever you list here: .env*, keys/certificates, .ssh, .aws, node_modules, .venv, .git.',
  'sandbox.copyUnmatched': 'No file matched: {globs}',
  'sandbox.copyDenied': '{n} matched file(s) blocked by the deny-list (secrets/bulk dirs never copy in).',
  'sandbox.copyIgnoredUnbounded':
    "{globs} doesn't constrain the file name -- it matches the whole project. Use a pattern like *.md, docs/*, or notes/** instead.",
  'sandbox.copyReset': 'Reset clone',
  'sandbox.imageCard': 'Image',
  'sandbox.imageBuild': 'Build image',
  'sandbox.imageRemove': 'Remove image',
  'sandbox.imageSave': 'Save',
  'sandbox.imageFound': 'present',
  'sandbox.imageMissing': 'missing',
  'sandbox.imageMissingHint':
    'The image is not built yet — Build image runs the Dockerfile shipped with Koryphaios (a few minutes on first run).',
  'sandbox.disconnect': 'Disconnect',
  'sandbox.projection': 'Operator config projected',
  'sandbox.projectionNone':
    'nothing projected yet (the config is copied into the container when it starts)',
  'sandbox.overlayPresent':
    'Overlay ~/.claude/sandbox-overrides: {files} (picked up at the next container start)',
  'sandbox.overlayRegenerate': 'Regenerate sandbox config',
  'sandbox.projectionRemove': 'Remove',
  'sandbox.projectionDisabledLine':
    'projection off: your global config is not carried into the container (Generate re-enables it)',
  'confirm.sandboxProjectionRemoveTitle': 'Stop projecting the operator config?',
  'confirm.sandboxProjectionRemoveMessage':
    'Your global config (CLAUDE.md, agents, skills, plugins, settings.json) is removed from the container and no longer copied at its next starts. The files in ~/.claude/sandbox-overrides stay untouched on this machine. "Generate sandbox config" re-enables the projection.',
  'confirm.sandboxProjectionRemoveConfirm': 'Remove',
  'toast.sandboxProjectionRemoved': 'Projection off: config removed from the container',
  'sandbox.overlayNone':
    'No overlay: Generate writes settings.json (host-only hooks stripped) into ~/.claude/sandbox-overrides.',
  'sandbox.projectionHint':
    'Your global CLAUDE.md, agents, skills, plugins and settings.json are COPIED into the container at each start (never mounted: a mounted settings.json would let a sandboxed agent plant a hook that runs on your machine). Drop Linux replacements in ~/.claude/sandbox-overrides/.',
  'sandbox.hookWarning': 'Hooks that cannot run inside the Linux container:',
  'sandbox.hookWarningRemedy':
    'Generate sandbox config writes an overlay without these hooks; to actually run them in the container, add their Linux dependencies to the custom image and provide Linux versions in ~/.claude/sandbox-overrides/.',
  'sandbox.overlayGenerate': 'Generate sandbox config',
  'sandbox.isolationNote':
    'By design, a sandboxed session shares your global config and Claude login, but NOT: hooks pointing at host paths or Windows binaries, host credentials (kleos, cred...), or MCP servers running on this machine. This is the isolation working, not a bug.',
  'sandbox.customCard': 'Custom image',
  'sandbox.customSave': 'Save',
  'sandbox.customBuild': 'Build custom image',
  'sandbox.customHint':
    'Dockerfile lines appended on top of the base image (RUN apt-get install..., ENV...). Built as a separate tag; the base image stays untouched. FROM lines are refused (the base is fixed).',
  'sandbox.customPlaceholder': 'RUN sudo apt-get update && sudo apt-get install -y postgresql-client',
  'sandbox.customUse': 'Use for this project',
  'toast.sandboxOverlayDone': 'Sandbox config generated: {n} host-only hook(s) removed',
  'confirm.sandboxOverlayTitle': 'Overwrite the existing overlay?',
  'confirm.sandboxOverlayMessage':
    '~/.claude/sandbox-overrides/settings.json already exists (possibly hand-edited). Generating replaces it with the host settings minus host-only hooks.',
  'confirm.sandboxOverlayConfirm': 'Overwrite',
  'sandbox.buildTitle': 'Building the sandbox image',
  'sandbox.buildHide': 'Hide',
  'sandbox.buildShowLog': 'Show log',
  'sandbox.building': 'Build in progress',
  'sandbox.buildHint':
    'Runs the Dockerfile shipped with Koryphaios. First build downloads a Debian base plus bun and the Claude CLI — a few minutes.',
  'confirm.sandboxModeTitle': 'Change the work mode?',
  'confirm.sandboxModeCopy':
    'Agents will work in a throwaway clone of the project instead of the real folder. The container is recreated to change the mount.',
  'confirm.sandboxModeMount':
    'Agents will edit your real project folder again. The container is recreated to change the mount.',
  'confirm.sandboxModeConfirm': 'Change',
  'confirm.sandboxDisconnectTitle': 'Disconnect the sandbox?',
  'confirm.sandboxDisconnectMessage':
    'Credentials are wiped from the shared volume: the next sandboxed session asks you to sign in again. Your own login on this machine is untouched.',
  'confirm.sandboxDisconnectConfirm': 'Disconnect',
  'confirm.sandboxForceCloseTitle': 'Close every running session?',
  'confirm.sandboxForceCloseMessage':
    '{n} session(s) will be closed, the supervisor included. Unsaved terminal work is lost; sandbox settings unlock right after.',
  'confirm.sandboxForceCloseConfirm': 'Close them all',
  'toast.sandboxSettingsSaved': 'Sandbox settings saved',
  'toast.sandboxImageBuilt': 'Sandbox image built',
  'toast.sandboxImageRemoved': 'Sandbox image removed',
  'confirm.sandboxImageRemoveTitle': 'Remove the sandbox image?',
  'confirm.sandboxImageRemoveMessage':
    'Sandboxed sessions cannot start until it is rebuilt. The engine refuses while any container still references it, and your sign-in (kory-claude-auth volume) is untouched.',
  'confirm.sandboxImageRemoveConfirm': 'Remove',
  'toast.sandboxDisconnected': 'Sandbox disconnected',
  'toast.sandboxCopyReset': 'Clone reset',
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
  'browser.pick':
    'Pick a page element for the docked agent (Esc cancels) — C picks the hovered element without clicking, S screenshots it, Esc exits',
  'browser.annotateReview':
    'Pin elements for a design review (comment, intent, priority per element), then send one message',
  'browser.annotatePanelTitle': 'Design review',
  'browser.annotateEmpty': 'Pick an element to start pinning it to the review.',
  'browser.annotateCommentPlaceholder': 'What should change here?',
  'browser.annotateIntentLabel': 'Intent',
  'browser.annotateIntentFix': 'Fix',
  'browser.annotateIntentChange': 'Change',
  'browser.annotateIntentQuestion': 'Question',
  'browser.annotateIntentApprove': 'Approve',
  'browser.annotatePriorityLabel': 'Priority',
  'browser.annotatePriorityBlocking': 'Blocking',
  'browser.annotatePriorityImportant': 'Important',
  'browser.annotatePrioritySuggestion': 'Suggestion',
  'browser.annotateRemove': 'Remove this annotation',
  'browser.annotateDiscard': 'Discard',
  'browser.annotateSend': 'Send review ({n})',
  'browser.devtools': "Open the page's DevTools",
  'browser.external': 'Open in the system browser',
  'browser.dockLabel': 'Docked agent',
  'browser.noDock': 'No docked agent',
  'browser.dockDetach': 'Undock (full-width browser)',
  'browser.backToAgents': 'Back to the Agents view',
  'browser.elementPrompt': 'On {url}, about the <{tag}> element ({w}x{h}px, selector: {selector}). ',
  'browser.elementPromptText': 'Visible text: "{text}". ',
  'browser.elementShotPrompt':
    ' A cropped screenshot of the element is saved at {path} — Read it to see the element in context.',
  'browser.elementShotOnly':
    'On {url}, a cropped screenshot of the <{tag}> element ({w}x{h}px, selector: {selector}) is saved at {path} — Read it. ',
  'toast.pickSent': "Element description pasted into the docked agent's prompt",
  'toast.pickCopied': 'No running docked agent — element description copied',
  'toast.shotFailed': 'Could not capture the element — try again',
  'toast.annotationCapReached': 'Review is full (20 elements) — send it or remove one first',
  'toast.reviewSent': "Design review pasted into the docked agent's prompt",
  'toast.reviewCopied': 'No running docked agent — design review copied',
  'tile.browserTitle': 'Open the browser view with this agent',
  'browser.viewport': 'Simulated device size',
  'browser.viewportResponsive': 'Responsive (fill)',
  'browser.viewportContext': '[viewport: {w}x{h} – {name}] ',
  'browser.draw':
    'Annotate the page (draw, then send a screenshot to the docked agent; Esc cancels)',
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
    'Pick an OS window to mirror it here — then annotate it and send the capture to the docked agent.',
  'browser.windowDrawPrompt':
    'I annotated a screenshot of the window "{title}": read the image file {path} to see the highlighted areas. ',
  'browser.record': 'Record a video (browser pane or whole window)',
  'browser.recordStop': 'Stop the recording and save the video',
  'browser.recordTitle': 'Record a video',
  'browser.recordHint':
    'Captures a demo-ready video (MP4/WebM). The file path is shown when you stop the recording with the same button.',
  'browser.recordScopeBrowser': 'Browser pane only (the embedded page)',
  'browser.recordScopeWindow': 'Whole Koryphaios window',
  'browser.recordStart': 'Start recording',
  'browser.recordScenario':
    'Scripted scenario (optional) — an agent drives the browser while it records',
  'browser.recordScenarioPlaceholder':
    'Describe what to show, e.g.: open the dashboard, create a project named Demo, show the settings page…',
  'browser.recordModel': 'Scenario model (Claude CLI)',
  'browser.recordStartScenario': 'Record the scenario',
  'browser.recordDemoRunning':
    'A demo agent is driving the browser — stopping the recording also stops it',
  'toast.recordSaved': 'Recording saved: {path}',
  'toast.recordFailed': 'Recording failed',
  'toast.recordFallbackWindow': 'Browser pane not capturable — recording the whole window',
  'toast.demoDone': 'Scenario finished — saving the recording',
  'toast.demoFailed': 'Demo scenario failed (see the log); the recording is saved anyway',
  'design.sourcePrefix': '[app: {source}] ',
  'nav.roadmap': 'Roadmap',
  'roadmap.title': 'Roadmap',
  'roadmap.add': '＋ Add item',
  'roadmap.empty':
    'The roadmap is empty. Add features, bugs, debt or ideas — agents can too, via their roadmap tools.',
  'roadmap.emptyFiltered': 'No card matches these filters.',
  'roadmap.shownCount': '{count} card(s) shown',
  'roadmap.showArchived': 'Show archived',
  'roadmap.error': 'Roadmap error: {error}',
  'roadmap.filter.title': 'Filters',
  'roadmap.filter.foldTitle': 'Fold the filters to their rail',
  'roadmap.filter.unfoldTitle': 'Unfold the filters',
  'roadmap.filter.search': 'Search',
  'roadmap.filter.searchPlaceholder': 'Search title, description...',
  'roadmap.filter.clearSearch': 'Clear search',
  'roadmap.filter.clearAll': 'Clear all',
  'roadmap.filter.hideInactive': 'Hide inactive',
  'roadmap.filter.hideInactiveHint': 'Hide cards the operator has deliberately set aside',
  'roadmap.filter.reset': 'Reset',
  'roadmap.filter.kind': 'Kind',
  'roadmap.filter.status': 'Status',
  'roadmap.filter.priority': 'Priority',
  'roadmap.filter.effort': 'Effort',
  'roadmap.filter.value': 'Value',
  'roadmap.filter.tags': 'Tags',
  'roadmap.filter.tagSearchPlaceholder': 'Filter tags...',
  'roadmap.filter.tagSearchLabel': 'Filter the tag list',
  'roadmap.filter.tagSearchClear': 'Clear the tag filter',
  'roadmap.filter.tagSearchEmpty': 'No tag matches',
  'roadmap.filter.removeChip': 'Remove this filter',
  'roadmap.kind.feature': 'Feature',
  'roadmap.kind.bug': 'Bug',
  'roadmap.kind.debt': 'Tech debt',
  'roadmap.kind.idea': 'Idea',
  'roadmap.kind.chore': 'Chore',
  'roadmap.kind.directive': 'Directive',
  'roadmap.directive.clear': '/clear (free reset)',
  'roadmap.directive.compact': '/compact (summarize)',
  'roadmap.directive.magic_compact': '/magic-compact',
  'roadmap.fieldDirective': 'Directive',
  'roadmap.fieldTargets': 'Target sessions',
  'roadmap.targetsEmpty': 'No live session to target',
  'roadmap.directiveHint':
    'The Deck types this command into the selected sessions when the card is dispatched from the queue.',
  'roadmap.directiveNotePlaceholder': 'Optional note (why this reset)',
  'roadmap.priority.must': 'Must have',
  'roadmap.priority.should': 'Should have',
  'roadmap.priority.could': 'Could have',
  'roadmap.priority.wont': "Won't have",
  'roadmap.level.low': 'low',
  'roadmap.level.medium': 'medium',
  'roadmap.level.high': 'high',
  'roadmap.status.idea': 'backlog',
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
  'roadmap.importPlan': 'Import a plan…',
  'toast.planImportStarted':
    'Import agent started — it converts the plan into roadmap items, then closes',
  'toast.roadmapSaved': 'Roadmap item saved',
  // Card f11e9e6a: creation does not open the detail modal, so this toast is
  // the whole acknowledgement -- it names the card on purpose.
  'toast.roadmapCreated': 'Card “{title}” created',
  'toast.idCopied': 'Item id copied',
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
  'inbox.hint': 'Closing a message never acknowledges it — it stays here until you do.',
  'inbox.openEntry': 'Open',
  'inbox.ack': 'Acknowledge',
  'inbox.reply': 'Reply',
  'inbox.decline': 'Decline',
  'inbox.delete': 'Delete',
  'inbox.replyPlaceholder': 'Your answer…',
  'inbox.familyMessage': 'Peer message',
  'inbox.familyEvent': 'Event',
  'inbox.familyBlocking': 'Blocking question',
  'inbox.state.unread': 'Unread',
  'inbox.state.seen': 'Seen — still to handle',
  'inbox.state.acked': 'Acknowledged',
  'inbox.noteClose': 'Closing does not acknowledge: the entry stays in the list.',
  'inbox.senderGone': 'This peer no longer exists: the message can be acknowledged, not answered.',
  'inbox.senderUnresolved': 'Unresolved sender —',
  'inbox.senderUnresolvedEmpty': 'Unresolved sender',
  'inbox.verdictRemoteBlocked':
    'Answering a blocking question requires the desktop app: a remote companion cannot render the human verdict an agent is waiting for.',
  'inbox.noteBlocking':
    'An agent is waiting on this question, so it cannot be acknowledged — only answered or declined.',
  'toast.inboxReplySent': 'Reply sent',
  'toast.inboxReplyRefused': 'Reply not delivered: the peer is unreachable',
  'toast.inboxAnswerSent': 'Answer sent — the agent is released',
  'toast.inboxAnsweredElsewhere': 'Already answered from another channel',
  'toast.inboxDeleted': 'Message deleted',
  'worktrees.diff': 'Diff',
  'sidebar.viewDiff': 'View diff',
  'diff.title': 'Diff — {name}',
  'diff.branchSection': 'Branch commits vs {base}',
  'diff.uncommittedSection': 'Uncommitted changes',
  'diff.noChanges': 'no changes',
  'diff.allClean': 'Working tree clean — nothing to review.',
  'diff.untracked': 'untracked',
  'diff.truncated': 'Diff truncated for display (the review agent reads the full one).',
  'diff.review': 'Have an agent review this',
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
  'files.explain': 'Explain',
  'files.createTask': 'Create a task',
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
  'roadmap.queueAdd': 'Queue for dispatch',
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
  'roadmap.wf.fullscreen': 'Open the workflow full screen',
  'roadmap.wf.exitFullscreen': 'Close the full-screen workflow',
  'roadmap.wf.resizeTitle': 'Drag to resize the canvas',
  'roadmap.wf.clearQueue': 'Clear',
  'roadmap.wf.clearQueueTitle': 'Clear the queue?',
  'roadmap.wf.clearQueueMessage':
    'Removes every queued card from the workflow lane. No roadmap item is deleted, and locked in-progress cards keep running untouched — this only empties the dispatch order.',
  'roadmap.wf.clearQueueConfirm': 'Clear',
  'roadmap.dispatchFirst': 'Send first to team-lead',
  'roadmap.dispatchNoLeadHint':
    'Designate a team-lead (the laurel badge in the Agents sidebar) to dispatch queued items.',
  'toast.dispatched': 'Item sent to the team-lead',
  'toast.dispatchNoLead': 'No team-lead — designate one first',
  'toast.dispatchFailed': 'Dispatch failed (empty queue or broker unreachable)',
  'roadmap.confirmDoneTitle': 'Mark as done?',
  'roadmap.confirmDoneMessage':
    'Mark "{title}" as done? Agents will no longer pick it up.',
  'roadmap.confirmDone': 'Mark done',
  'roadmap.lockedHint': 'An agent is actively working on this item (locked)',
  'roadmap.copyId': 'Copy the item id',
  'roadmap.lockedSince': 'Locked by {name} since {date}',
  'roadmap.dependsOn': 'Depends on',
  'roadmap.addDep': 'Add dependency',
  'roadmap.stop': 'Stop',
  'roadmap.confirmStopTitle': 'Stop work on this item?',
  'roadmap.confirmStopMessage':
    'Agents will be told to stop working on "{title}". The item is unlocked and returns to planned.',
  'roadmap.prioPick': 'click to change priority',
  'roadmap.menuEdit': 'Edit…',
  'roadmap.menuQueue': 'Add to dispatch queue',
  'roadmap.menuAssign': 'Process now…',
  'roadmap.menuDelete': 'Delete (archives)',
  'roadmap.menuMarkInactive': 'Mark inactive (operator only)',
  'roadmap.menuReactivate': 'Reactivate',
  'roadmap.inactiveBadge': 'Inactive',
  'roadmap.inactiveHint':
    'Deliberately set aside by the operator -- agents cannot claim or queue this card until it is reactivated',
  'roadmap.assignTitle': 'Process now',
  'roadmap.assignHint':
    'Send "{title}" to a live agent (targeted announce), or spawn a fresh one on it.',
  'roadmap.assignNoAgents': 'No live agent with a resolved peer_id — spawn a new one.',
  'roadmap.assignNew': '＋ New agent on this item…',
  'roadmap.stop.pause': 'Pause',
  'roadmap.stop.pauseHint': 'Pause every agent, keep their cards locked',
  'roadmap.stop.soft': 'Soft stop',
  'roadmap.stop.softHint': 'Ask every agent to stop at its next turn and hand its card back',
  'roadmap.stop.hard': 'Hard stop',
  'roadmap.stop.hardHint': 'Interrupt every agent now and release every card they hold',
  'roadmap.stop.flipToHard': 'Switch to hard stop',
  'roadmap.stop.flipToSoft': 'Switch to soft stop',
  'roadmap.stop.unavailable': 'Fleet stop unavailable in this build (no agents:stop channel)',
  'roadmap.stop.noAgents': 'No live agent to stop',
  'roadmap.stop.busy': 'Stop in progress...',
  'roadmap.stop.confirmPause': 'Pause {count} agent(s)?',
  'roadmap.stop.confirmPauseMsg':
    'Their work is interrupted and their cards STAY locked ({busy} busy right now).',
  'roadmap.stop.confirmSoft': 'Stop {count} agent(s)?',
  'roadmap.stop.confirmSoftMsg':
    'Each agent is asked to stop at its next turn and hand its card back. An agent stuck busy will not take it: the report names those.',
  'roadmap.stop.confirmHard': 'Hard stop {count} agent(s)?',
  'roadmap.stop.confirmHardMsg':
    'They are interrupted now and every card they hold is released ({parked} card(s) parked right now).',
  'roadmap.stop.confirmPauseSubset': 'Pause {count} straggler(s)?',
  'roadmap.stop.confirmPauseSubsetMsg':
    'Only these {count} agent(s) are interrupted, and they KEEP their cards.',
  'roadmap.stop.confirmSoftSubset': 'Soft stop {count} straggler(s)?',
  'roadmap.stop.confirmSoftSubsetMsg':
    'Only these {count} agent(s) are asked to stop and hand their card back. The others are untouched.',
  'roadmap.stop.confirmHardSubset': 'Hard stop {count} straggler(s)?',
  'roadmap.stop.confirmHardSubsetMsg':
    'Only these {count} agent(s) are interrupted and their cards released. The agents that took the stop keep theirs.',
  'roadmap.stop.report.pause': 'Pause report',
  'roadmap.stop.report.soft': 'Soft stop report',
  'roadmap.stop.report.hard': 'Hard stop report',
  'roadmap.stop.report.failed': 'Stop failed',
  'roadmap.stop.failed': 'The stop failed: {error}',
  'roadmap.stop.took': '{count} agent(s) took the stop',
  'roadmap.stop.notTook': '{count} agent(s) did NOT take it (still busy)',
  'roadmap.stop.unreachable': '{count} agent(s) unreachable (no terminal, or error)',
  'roadmap.stop.parked': '{count} card(s) parked',
  'roadmap.stop.released': '{count} card(s) released',
  'roadmap.stop.lockError': 'Card locks: {error}',
  'roadmap.stop.stragglers': 'Did not take the stop',
  'roadmap.stop.escalateHint':
    'These {count} agent(s) are still running. Escalate to a hard stop if you want their cards back.',
  'roadmap.stop.hardStragglers':
    '{count} agent(s) stayed busy through the hard stop: check their terminal.',
  'roadmap.stop.escalateNoPeer':
    '{count} of them have no peer id and cannot be targeted: stop them from their own tile.',
  'roadmap.stop.noPeer': 'no peer id',
  'roadmap.stop.missing':
    '{count} requested target(s) no longer exist: no live tile carries that peer id. They did not refuse the stop, they were never asked.',
  'roadmap.stop.written': 'Stop message written to {count} agent(s), unconfirmed',
  'roadmap.stop.writtenTitle': 'Transmitted, unconfirmed',
  'roadmap.stop.writtenNote':
    'Transmitted is not stopped: the Deck wrote the message into their terminal, nothing came back. A soft stop is a request, not a guarantee — check the tile, or escalate.',
  'roadmap.stop.escalateUnconfirmed':
    'None of these {count} agent(s) is a confirmed stop: transmitted without an answer, or still busy. Escalate to a hard stop to get their cards back.',
  'roadmap.stop.refused': '{count} agent(s) refused: their screen looked like an open dialog, nothing was sent',
  'roadmap.stop.refusedTitle': 'Refused: dialog looked open',
  'roadmap.stop.refusedNote':
    'The Deck would not type into these tiles: their screen looked like an open dialog (a trust or confirm prompt), where either keystroke could have quit the session or accepted something in your name. Nothing was sent -- escalate to a hard stop if you need this tile back.',
  'roadmap.stop.escalateRefused':
    'None of these {count} agent(s) took the stop: their screen looked like an open dialog, so nothing was sent. Escalate to a hard stop to get their cards back.',
  'toast.assignSent': 'Item sent to the agent (moved to in progress)',
  'toast.assignFailed': 'Assignment failed (peer unreachable or broker down)',
  'toast.stopSupervisor': 'Stop routed through the supervisor — it will report back to your inbox',
  'toast.stopBroadcast': 'Stop broadcast to the group',
  'toast.stopNoPeers': 'Item unlocked (no active peer to notify)',
  'toast.stopFailed': 'Stop failed (item not found or broker unreachable)',
  'help.digestTitle': 'Resume digest — where things stand and what to do next',
  'help.digestQuestion': 'Resume digest',
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
  'graph.foldTitle': 'Fold the panel to its rail',
  'graph.unfoldTitle': 'Unfold the panel',
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
  'graph.resize': 'Drag to resize',
  'graph.wireConnect': 'Drag onto another node to connect it as a child (cycles are refused).',
  'graph.inspect': 'Inspect context',
  'graph.inspectorTitle': 'Compiled context (sent as system side)',
  'graph.inspectorPrompt': "Prompt (the node's message)",
  'graph.promptPlaceholder': 'Your message… (what if…? go deeper on…)',
  'graph.targets': 'Inference targets',
  'graph.battle': 'Battle mode (judge node merges the answers)',
  'graph.battleHint':
    'Each checked CLI answers independently, then a judge node compares the anonymized answers and produces the merged one.',
  'graph.judge': 'Judge (claude)',
  'graph.infer': 'Infer',
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
  'settings.modelsDetected': 'detected',
  'settings.modelsMissing': 'not detected',
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
  'mobile.lift': 'Lift',
  'nav.usage': 'Usage limits',
  'usage.title': 'Usage limits',
  'usage.refresh': 'Refresh (bypass the cache)',
  'usage.loading': 'Reading the CLIs…',
  'usage.failed': 'Could not read usage data.',
  'usage.none': 'No supported CLI detected (Claude Code, Codex, Antigravity).',
  'usage.win.session': 'Current session',
  'usage.win.sessionOf': 'Session — {name}',
  'usage.win.week': 'Weekly — all models',
  'usage.win.weekOf': 'Weekly — {name}',
  'usage.win.weekModel': 'Weekly — {name} only',
  'usage.pool3p': 'Other models',
  'usage.used': '{pct}% used',
  'usage.resetsIn': 'resets in {time}',
  'usage.resetsAt': 'resets {time}',
  'usage.resetsNow': 'resetting…',
  'usage.credits': 'Extra-usage credits',
  'usage.creditsOff': 'not enabled',
  'usage.creditsOn': 'enabled',
  'usage.notConnected': 'CLI installed, but not signed in.',
  'usage.error': 'Unavailable',
  'usage.stale': 'Last known values (local session snapshot).',
  'usage.updated': 'Updated at {time}',
  'usage.remainingTip': '{pct}% session quota remaining'
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
