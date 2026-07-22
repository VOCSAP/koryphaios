import type { DeckView } from '@shared/types'

// Greek-glyph icon set of the navigation rails (desktop rail + mobile tabs).
// Hand-drawn inline SVGs — no icon font, no CDN — so the packaged app and the
// companion client stay self-contained. Visual language (DESIGN.md §
// "Iconography"): 24×24 grid, stroke-only (`currentColor`, width 1.5, round
// caps/joins), no fills except tiny "dot" accents. Colour, hover/active states
// and the attention glow are entirely CSS-driven through `currentColor` +
// `drop-shadow`, which is why the SVGs must never hardcode a colour.
//
// Each glyph trades the generic VS Code metaphor for a mythological one
// (Κορυφαῖος leads the chorus): temple = supervisor's home, theatre mask =
// agents (the chorus), armillary sphere = browser, sealed scroll = files,
// labyrinth = roadmap, constellation = graph, olive branch = worktrees,
// open volumen = journal, winged tablet = companion, caduceus = inbox
// (Hermes carries the messages). Git keeps the universal branch graph —
// recognisability wins over lore for SCM.

/** Shared frame so every glyph renders identically inside the rail spans. */
function Svg({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      className="glyph"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Filled star/point accent (the only allowed fill, DESIGN.md). */
function Dot({ cx, cy, r = 1.4 }: { cx: number; cy: number; r?: number }): React.JSX.Element {
  return <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
}

/** Temple front (pediment + columns): the supervisor's seat. */
const IconTemple = (
  <Svg>
    <path d="M3.5 9.5 12 4l8.5 5.5" />
    <path d="M5 9.5h14" />
    <path d="M7 12.5v5M12 12.5v5M17 12.5v5" />
    <path d="M4.5 20h15" />
  </Svg>
)

/** Theatre mask (the chorus = the agents). */
const IconMask = (
  <Svg>
    <path d="M6.5 4h11c.8 0 1.5.7 1.5 1.5V12c0 4.7-3.1 8-7 8s-7-3.3-7-8V5.5C5 4.7 5.7 4 6.5 4Z" />
    <path d="M8.5 9.5c.4-.6 1.2-.6 1.6 0M13.9 9.5c.4-.6 1.2-.6 1.6 0" />
    <path d="M8.5 13.5c1 2.2 6 2.2 7 0" />
  </Svg>
)

/** Armillary sphere: the window on the world (browser). */
const IconSphere = (
  <Svg>
    <circle cx="12" cy="12" r="7.5" />
    <ellipse cx="12" cy="12" rx="3.2" ry="7.5" />
    <path d="M4.5 12h15" />
  </Svg>
)

/** Sealed scroll (two rolls + sheet): the files. */
const IconScroll = (
  <Svg>
    <rect x="5" y="4" width="14" height="4.5" rx="2.25" />
    <rect x="5" y="15.5" width="14" height="4.5" rx="2.25" />
    <path d="M7 8.5v7M17 8.5v7" />
  </Svg>
)

/** Branch graph: universal SCM metaphor, kept as-is (git view). */
const IconBranch = (
  <Svg>
    <circle cx="7" cy="6" r="1.8" />
    <circle cx="7" cy="18" r="1.8" />
    <circle cx="17" cy="9" r="1.8" />
    <path d="M7 7.8v8.4" />
    <path d="M7 13c0-3 4-4 8.2-4" />
  </Svg>
)

/** Labyrinth (squared spiral): the roadmap through the maze. */
const IconLabyrinth = (
  <Svg>
    <path d="M4.5 4.5h15v15h-15v-11h11v7h-7V12" />
  </Svg>
)

/** Constellation: the graph canvas (nodes drawn in the sky). */
const IconConstellation = (
  <Svg>
    <path d="M5.5 17.5 10 6.5l4.5 5.5L19 5.5M14.5 12l1.5 6.5" />
    <Dot cx={5.5} cy={17.5} />
    <Dot cx={10} cy={6.5} />
    <Dot cx={14.5} cy={12} />
    <Dot cx={19} cy={5.5} />
    <Dot cx={16} cy={18.5} />
  </Svg>
)

/** Olive branch: a living offshoot of the tree (worktrees). */
const IconOlive = (
  <Svg>
    <path d="M6.5 19.5C9.5 16 13 12 17.5 5" />
    <path d="M12.6 12.2C10.6 12.6 8.8 11.8 8 9.9c2.1-.5 3.9.3 4.6 2.3Z" />
    <path d="M14.9 8.9c-.4-2 .4-3.8 2.3-4.6.5 2.1-.3 3.9-2.3 4.6Z" />
    <path d="M10 15.6c-1.9.4-3.6-.3-4.4-2.1 1.9-.5 3.6.2 4.4 2.1Z" />
  </Svg>
)

/** Open volumen (unrolled scroll with written lines): the journal. */
const IconVolumen = (
  <Svg>
    <rect x="3.5" y="5" width="3.2" height="14" rx="1.6" />
    <rect x="17.3" y="5" width="3.2" height="14" rx="1.6" />
    <path d="M6.7 6.2h10.6M6.7 17.8h10.6" />
    <path d="M9.5 10h5M9.5 13h5" />
  </Svg>
)

/** Winged tablet: the companion device carried by the messenger. */
const IconWingedTablet = (
  <Svg>
    <rect x="8.5" y="4" width="7" height="16" rx="1.8" />
    <path d="M11 17.5h2" />
    <path d="M8.5 8.5c-2.3 0-3.7 1.3-4.2 3.3M8.5 11.5c-1.4 0-2.3.8-2.7 2.1" />
    <path d="M15.5 8.5c2.3 0 3.7 1.3 4.2 3.3M15.5 11.5c1.4 0 2.3.8 2.7 2.1" />
  </Svg>
)

/** Caduceus of Hermes: the operator inbox (messages travel with him). */
const IconCaduceus = (
  <Svg>
    <path d="M12 6.5v13.5" />
    <circle cx="12" cy="4.4" r="1.3" />
    <path d="M11.2 7.2C9.8 5.8 7.8 5.9 6.8 7.4M12.8 7.2c1.4-1.4 3.4-1.3 4.4.2" />
    <path d="M8.3 9.5c0 1.8 7.4 2.4 7.4 4.3 0 1.9-7.4 2.5-7.4 4.3" />
    <path d="M15.7 9.5c0 1.8-7.4 2.4-7.4 4.3 0 1.9 7.4 2.5 7.4 4.3" />
  </Svg>
)

/** Ellipsis: the mobile "More" sheet. */
const IconMore = (
  <Svg>
    <Dot cx={6} cy={12} />
    <Dot cx={12} cy={12} />
    <Dot cx={18} cy={12} />
  </Svg>
)

// ----- Action glyphs (buttons everywhere: tile heads, panel closes, toolbars) -----
// Same visual language as the rail set. Sizing is NOT set here: `svg.glyph`
// renders at 1em, so each host button keeps its own metrics (rails override
// to a fixed 20px). Generic actions stay universal shapes — the mythology is
// reserved for destinations (rail) and identity moments (the bolt).

/** Thunderbolt of Zeus: instant power — the saved-prompts (snippets) menu. */
const IconBolt = (
  <Svg>
    <path d="M13.2 3.5 6.5 13.2h4.3L10.8 20.5l6.7-9.7h-4.3l0-7.3Z" />
  </Svg>
)

/** Expand to full area (maximize). */
const IconExpand = (
  <Svg>
    <path d="M14 4.5h5.5V10M19.5 4.5 13 11" />
    <path d="M10 19.5H4.5V14M4.5 19.5 11 13" />
  </Svg>
)

/** Back to the grid (restore). */
const IconRestore = (
  <Svg>
    <path d="M19.5 10H14V4.5M14 10l5.5-5.5" />
    <path d="M4.5 14H10v5.5M10 14l-5.5 5.5" />
  </Svg>
)

/** Close. */
const IconClose = (
  <Svg>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
)

/** Edit / rename / annotate (stylus). */
const IconEdit = (
  <Svg>
    <path d="M4.5 19.5v-4.2L15.3 4.5l4.2 4.2L8.7 19.5H4.5Z" />
    <path d="m13.2 6.6 4.2 4.2" />
  </Svg>
)

/** Delete. */
const IconTrash = (
  <Svg>
    <path d="M4.5 6.5h15" />
    <path d="M9.5 6.5V5.4c0-.5.4-.9.9-.9h3.2c.5 0 .9.4.9.9v1.1" />
    <path d="m6.5 6.5.9 12.6c0 .5.45.9 1 .9h7.2c.55 0 1-.4 1-.9l.9-12.6" />
    <path d="M10 10v6.5M14 10v6.5" />
  </Svg>
)

/** Reload / refresh. */
const IconRefresh = (
  <Svg>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.3-5.4" />
    <path d="M17.5 3v3.8h-3.8" />
  </Svg>
)

/** Search (magnifier). */
const IconSearch = (
  <Svg>
    <circle cx="10.8" cy="10.8" r="5.8" />
    <path d="m15 15 4.8 4.8" />
  </Svg>
)

/** Copy / duplicate / digest-to-clipboard (two sheets). */
const IconCopy = (
  <Svg>
    <rect x="4.5" y="8" width="11.5" height="11.5" rx="1.2" />
    <path d="M8.5 5h9.5c.8 0 1.5.7 1.5 1.5V16" />
  </Svg>
)

/** Add. */
const IconPlus = (
  <Svg>
    <path d="M12 5.5v13M5.5 12h13" />
  </Svg>
)

/** Remove / zoom out. */
const IconMinus = (
  <Svg>
    <path d="M5.5 12h13" />
  </Svg>
)

/** Fit view (frame corners). */
const IconFit = (
  <Svg>
    <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />
  </Svg>
)

/** Auto-arrange (grid). */
const IconGrid = (
  <Svg>
    <rect x="4.5" y="4.5" width="15" height="15" rx="1.5" />
    <path d="M12 4.5v15M4.5 12h15" />
  </Svg>
)

/** Timeline / list (bars). */
const IconMenu = (
  <Svg>
    <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />
  </Svg>
)

/** Back / forward chevrons. */
const IconBack = (
  <Svg>
    <path d="m14.5 5-7 7 7 7" />
  </Svg>
)
const IconForward = (
  <Svg>
    <path d="m9.5 5 7 7-7 7" />
  </Svg>
)

/** Terminal screen (dock back to the agents). */
const IconScreen = (
  <Svg>
    <rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" />
    <path d="M9.5 19.5h5M12 16v3.5" />
  </Svg>
)

/** OS window (window-capture mode). */
const IconWindow = (
  <Svg>
    <rect x="4" y="5" width="16" height="14.5" rx="1.5" />
    <path d="M4 9h16" />
    <Dot cx={6.3} cy={7} r={0.8} />
    <Dot cx={8.7} cy={7} r={0.8} />
  </Svg>
)

/** Camera (send the annotated screenshot). */
const IconCamera = (
  <Svg>
    <rect x="3.5" y="7.5" width="17" height="11.5" rx="1.5" />
    <path d="M8.5 7.5 9.8 5h4.4l1.3 2.5" />
    <circle cx="12" cy="13" r="3" />
  </Svg>
)

/** Element picker (crosshair). */
const IconTarget = (
  <Svg>
    <circle cx="12" cy="12" r="5.5" />
    <path d="M12 4v3M12 17v3M4 12h3M17 12h3" />
    <Dot cx={12} cy={12} r={1.2} />
  </Svg>
)

/** Clear drawing (backspace). */
const IconErase = (
  <Svg>
    <path d="M8.5 5.5h10c.8 0 1.5.7 1.5 1.5v10c0 .8-.7 1.5-1.5 1.5h-10L3 12l5.5-6.5Z" />
    <path d="m11 9.5 5 5m0-5-5 5" />
  </Svg>
)

/** DevTools (code brackets). */
const IconCode = (
  <Svg>
    <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />
  </Svg>
)

/** Open in the system browser (arrow out of the box). */
const IconExternal = (
  <Svg>
    <path d="M19 13.5V18c0 .8-.7 1.5-1.5 1.5h-11C5.7 19.5 5 18.8 5 18V7c0-.8.7-1.5 1.5-1.5H10" />
    <path d="M14.5 4.5h5v5M19.5 4.5 12 12" />
  </Svg>
)

/** Action icons, keyed by intent; view destinations stay in GLYPHS. */
export const GLYPH_ACTIONS = {
  snippets: IconBolt,
  expand: IconExpand,
  restore: IconRestore,
  close: IconClose,
  edit: IconEdit,
  trash: IconTrash,
  refresh: IconRefresh,
  search: IconSearch,
  copy: IconCopy,
  plus: IconPlus,
  minus: IconMinus,
  fit: IconFit,
  grid: IconGrid,
  menu: IconMenu,
  back: IconBack,
  forward: IconForward,
  screen: IconScreen,
  window: IconWindow,
  camera: IconCamera,
  target: IconTarget,
  erase: IconErase,
  code: IconCode,
  external: IconExternal
}

/** Every place a rail glyph can appear: the 9 views + the two rail extras. */
export type GlyphName = DeckView | 'companion' | 'inbox' | 'more'

export const GLYPHS: Record<GlyphName, React.JSX.Element> = {
  home: IconTemple,
  agents: IconMask,
  browser: IconSphere,
  files: IconScroll,
  git: IconBranch,
  roadmap: IconLabyrinth,
  graph: IconConstellation,
  worktrees: IconOlive,
  journal: IconVolumen,
  companion: IconWingedTablet,
  inbox: IconCaduceus,
  more: IconMore
}
