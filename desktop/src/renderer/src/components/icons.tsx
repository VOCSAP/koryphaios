import { useId } from 'react'
import type { DeckView, RoadmapKind } from '@shared/types'

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
// pithos = the sandbox container (Diogenes lived in his jar), open volumen =
// journal, winged tablet = companion, caduceus = inbox
// (Hermes carries the messages), amphora = usage limits (the level left in
// the jar). Git keeps the universal branch graph — recognisability wins over
// lore for SCM.

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

/** Pithos (Diogenes' storage jar, lidded and banded): the sandbox container. */
const IconPithos = (
  <Svg>
    <path d="M8.2 4.5h7.6" />
    <path d="M9.2 4.5v1.7c-2.5 1-4 3.1-4 5.7 0 3.5 2.1 6.3 4.5 7.6h4.6c2.4-1.3 4.5-4.1 4.5-7.6 0-2.6-1.5-4.7-4-5.7V4.5" />
    <path d="M6 13.2h12" />
    <path d="M7.3 16.4h9.4" />
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

/** Amphora with its fill line: how much is left in the jar (usage limits). */
const IconAmphora = (
  <Svg>
    <path d="M9 4.5h6" />
    <path d="M10 4.5v2M14 4.5v2" />
    <path d="M10 6.5c-2.5.8-4 2.6-4 4.9 0 3.3 2.2 5.5 4.5 6.3M14 6.5c2.5.8 4 2.6 4 4.9 0 3.3-2.2 5.5-4.5 6.3" />
    <path d="M9.5 19.5h5" />
    <path d="M9.3 13.5h5.4" />
  </Svg>
)

/** Closed silhouette of the amphora body — the clip region of the gauge. */
const AMPHORA_BODY =
  'M10 6.5 C7.5 7.3 6 9.1 6 11.4 c0 3.3 2.2 5.5 4.5 6.3 h3 c2.3 -0.8 4.5 -3 4.5 -6.3 C18 9.1 16.5 7.3 14 6.5 Z'

/**
 * Data-driven amphora (nav rail): the jar's liquid level IS the remaining
 * session quota (shared/usage.ts). The liquid is a translucent currentColor
 * fill clipped to the body — the one sanctioned data-fill exception to the
 * stroke-only glyph rule (DESIGN.md §5); colour still rides currentColor so
 * the tone classes (.usage-ok/.usage-warn/.usage-hot) do the tinting.
 * `fraction` null = no data: render the static fill-line variant.
 */
export function AmphoraGauge({ fraction }: { fraction: number | null }): React.JSX.Element {
  const clipId = useId()
  // Body vertical range on the 24-grid: shoulders at 6.5, foot line at 17.7.
  const top = 6.5
  const bottom = 17.7
  const level = fraction === null ? null : Math.min(1, Math.max(0, fraction))
  const y = level === null ? bottom : top + (bottom - top) * (1 - level)
  return (
    <Svg>
      <path d="M9 4.5h6" />
      <path d="M10 4.5v2M14 4.5v2" />
      <path d="M10 6.5c-2.5.8-4 2.6-4 4.9 0 3.3 2.2 5.5 4.5 6.3M14 6.5c2.5.8 4 2.6 4 4.9 0 3.3-2.2 5.5-4.5 6.3" />
      <path d="M9.5 19.5h5" />
      {level === null ? (
        <path d="M9.3 13.5h5.4" />
      ) : (
        <>
          <clipPath id={clipId}>
            <path d={AMPHORA_BODY} />
          </clipPath>
          <rect
            x="5"
            y={y}
            width="14"
            height={bottom - y + 0.6}
            clipPath={`url(#${clipId})`}
            fill="currentColor"
            stroke="none"
            opacity="0.45"
          />
        </>
      )}
    </Svg>
  )
}

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

/** Screen recording (the universal REC ring — an omphalos seen from above). */
const IconRecord = (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <Dot cx={12} cy={12} r={3} />
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

/** Folder (browse a directory, local-snippet marker). */
const IconFolder = (
  <Svg>
    <path d="M4 6.5c0-.6.4-1 1-1h4.5l2 2.5H19c.6 0 1 .4 1 1v9c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1v-11.5Z" />
  </Svg>
)

/** Confirmation check. */
const IconCheck = (
  <Svg>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
)

/** Context wand (the rhabdos): AI-fills the roadmap context field. */
const IconWand = (
  <Svg>
    <path d="M4.5 19.5 14.5 9.5" />
    <path d="m17 3.5.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z" />
    <Dot cx={19.5} cy={12.5} r={1} />
    <Dot cx={12} cy={4.5} r={1} />
  </Svg>
)

// ----- Badge glyphs (semantic markers, not clickable actions) -----
// The mythological register comes back here: these mark WHO/WHAT something
// is (lead, judge, battle, waiting…), the identity layer of the Deck.

/** Laurel crown: the team lead (the κορυφαῖος wears it). */
const IconLaurel = (
  <Svg>
    <path d="M11.5 20C7 17.5 5 13 5.5 7.5" />
    <path d="M5.5 7.5C4 7 3.2 5.7 3.2 4M6.3 12.2c-1.7.2-3-.5-3.7-1.9M8.3 16.2c-1.6.6-3 .3-4-.8" />
    <path d="M12.5 20c4.5-2.5 6.5-7 6-12.5" />
    <path d="M18.5 7.5c1.5-.5 2.3-1.8 2.3-3.5M17.7 12.2c1.7.2 3-.5 3.7-1.9M15.7 16.2c1.6.6 3 .3 4-.8" />
  </Svg>
)

/** Scales of Themis: the judge node / battle verdict. */
const IconScales = (
  <Svg>
    <path d="M12 5v14.5M8.5 19.5h7" />
    <path d="M5 7h14" />
    <Dot cx={12} cy={4.4} r={1} />
    <path d="M5 7.2 2.8 12M5 7.2 7.2 12" />
    <path d="M2.6 12a2.4 2.4 0 0 0 4.8 0" />
    <path d="M19 7.2 16.8 12M19 7.2l2.2 4.8" />
    <path d="M16.6 12a2.4 2.4 0 0 0 4.8 0" />
  </Svg>
)

/** Crossed xiphos: battle mode (models duel, the judge decides). */
const IconSwords = (
  <Svg>
    <path d="M5 4.5 19 18.5M19 4.5 5 18.5" />
    <path d="m14.6 17.4 2.8 2.8M9.4 17.4l-2.8 2.8" />
  </Svg>
)

/** Clepsydra (water clock): waiting — rate-limited session, queued item. */
const IconClepsydra = (
  <Svg>
    <path d="M6.5 4.5h11M6.5 19.5h11" />
    <path d="M7.3 4.5c0 3.8 3.2 5.2 4.7 7 1.5-1.8 4.7-3.2 4.7-7" />
    <path d="M7.3 19.5c0-3.8 3.2-5.2 4.7-7 1.5 1.8 4.7 3.2 4.7 7" />
    <Dot cx={12} cy={15.8} r={0.9} />
  </Svg>
)

/** Head in profile: the operator's own node in the graph. */
const IconProfile = (
  <Svg>
    <path d="M9.5 20v-2.6C7.4 16.2 6 14 6 11.4 6 7.5 8.7 4.5 12.4 4.5c3.5 0 6.1 2.6 6.1 6 0 1.3-.3 2.4-.9 3.5l1.2 2.2c.3.6-.1 1.3-.8 1.3h-1.5v1.5c0 .6-.4 1-1 1" />
  </Svg>
)

/** Olympic torch, lit: the remote link is coming back. */
const IconTorchLit = (
  <Svg>
    <path d="M8 10h8l-1.1 2.4c-.5 1-1.4 1.6-2.9 1.6s-2.4-.6-2.9-1.6L8 10Z" />
    <path d="M12 14v5.5M9.5 19.5h5" />
    <path d="M12 8.2c-2-1.4-2.2-3.5 0-5.7 2.2 2.2 2 4.3 0 5.7Z" />
  </Svg>
)

/** Olympic torch, extinguished: the host is gone. */
const IconTorchOut = (
  <Svg>
    <path d="M8 10h8l-1.1 2.4c-.5 1-1.4 1.6-2.9 1.6s-2.4-.6-2.9-1.6L8 10Z" />
    <path d="M12 14v5.5M9.5 19.5h5" />
    <path d="M10.5 7.5c.5-.7 2.5-.7 3-1.5" />
  </Svg>
)

/** Padlock: a roadmap item an agent is working on. */
const IconLock = (
  <Svg>
    <rect x="6.5" y="10.5" width="11" height="9" rx="1.5" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    <Dot cx={12} cy={15} r={1.1} />
  </Svg>
)

/** Warning triangle. */
const IconWarning = (
  <Svg>
    <path d="M10.7 5.2 3.6 17.4c-.6 1 .2 2.1 1.3 2.1h14.2c1.1 0 1.9-1.1 1.3-2.1L13.3 5.2c-.6-1-2-1-2.6 0Z" />
    <path d="M12 9.5v4" />
    <Dot cx={12} cy={16.4} r={0.9} />
  </Svg>
)

/** Gear: settings. */
const IconGear = (
  <Svg>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 4v2.4M12 17.6V20M4 12h2.4M17.6 12H20M6.3 6.3 8 8M16 16l1.7 1.7M17.7 6.3 16 8M8 16l-1.7 1.7" />
  </Svg>
)

/** Capsa (the Roman scroll box): the saved workspaces. */
const IconCapsa = (
  <Svg>
    <ellipse cx="12" cy="6.5" rx="6.5" ry="2" />
    <path d="M5.5 6.5V17c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V6.5" />
    <path d="M5.5 12c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" />
  </Svg>
)

/** Paperclip: code selection attached to the next help question. */
const IconClip = (
  <Svg>
    <path d="m8.2 12.3 6-6a3 3 0 0 1 4.3 4.3l-7.5 7.4a4.6 4.6 0 0 1-6.5-6.5l7.3-7.2" />
  </Svg>
)

/** Archive box: the archived-items tab. */
const IconArchive = (
  <Svg>
    <rect x="4" y="5" width="16" height="4" rx="1" />
    <path d="M5.5 9v9.5c0 .6.4 1 1 1h11c.6 0 1-.4 1-1V9" />
    <path d="M10 12.5h4" />
  </Svg>
)

/** Lift back to the surface (detach from the queue/board). */
const IconLift = (
  <Svg>
    <path d="M12 16.5V5M8 8.5 12 5l4 3.5" />
    <path d="M5.5 19.5h13" />
  </Svg>
)

/** Favourite star, outline and pinned (the only full-fill glyph: a lit star). */
const IconStar = (
  <Svg>
    <path d="m12 4.6 2.2 4.6 5 .7-3.6 3.5.9 5L12 16l-4.5 2.4.9-5-3.6-3.5 5-.7L12 4.6Z" />
  </Svg>
)
const IconStarFilled = (
  <Svg>
    <path
      d="m12 4.6 2.2 4.6 5 .7-3.6 3.5.9 5L12 16l-4.5 2.4.9-5-3.6-3.5 5-.7L12 4.6Z"
      fill="currentColor"
    />
  </Svg>
)

/** Multi-select checkboxes (model picker fan-out). */
const IconCheckboxOff = (
  <Svg>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </Svg>
)
const IconCheckboxOn = (
  <Svg>
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <path d="m8.5 12.5 2.5 2.5 5-5.5" />
  </Svg>
)

// ----- Roadmap kind glyphs (coloured via .kind-glyph-* classes) -----

/** Feature: a four-point star (something new under the sky). */
const IconKindFeature = (
  <Svg>
    <path d="m12 4 1.8 6.2L20 12l-6.2 1.8L12 20l-1.8-6.2L4 12l6.2-1.8L12 4Z" />
  </Svg>
)

/** Bug: the scarab. */
const IconKindBug = (
  <Svg>
    <ellipse cx="12" cy="13.5" rx="4.2" ry="5.5" />
    <circle cx="12" cy="6" r="1.7" />
    <path d="M12 8.7V19M8 11.2 5 9.7M7.8 14.5H4.6M8 17.5l-3 1.5M16 11.2l3-1.5M16.2 14.5h3.2M16 17.5l3 1.5" />
  </Svg>
)

/** Technical debt: the wall of bricks. */
const IconKindDebt = (
  <Svg>
    <rect x="4" y="6" width="16" height="13" />
    <path d="M4 10.3h16M4 14.7h16M12 6v4.3M8.5 10.3v4.4M15.5 10.3v4.4M12 14.7V19" />
  </Svg>
)

/** Idea: the oil lamp (an ampoule would be an anachronism). */
const IconKindIdea = (
  <Svg>
    <path d="M4.5 12.5h9.8c2 0 3.6-.7 4.7-2.2" />
    <path d="M4.5 12.5c.4 3.4 2.9 5.5 6.3 5.5 2.8 0 4.9-1.4 5.8-3.7" />
    <path d="M19 9.5c-1-.8-1.1-2.1 0-3.3 1.1 1.2 1 2.5 0 3.3Z" />
    <Dot cx={8} cy={15} r={0.9} />
  </Svg>
)

/** Chore: the broom. */
const IconKindChore = (
  <Svg>
    <path d="M18.5 4.5l-7.6 7.6" />
    <path d="M10.9 12.1 6 14.6c-1.5.8-2 2.3-1.3 3.8l.4.9c2 .4 3.7 0 5-1.1l3.4-3.5-2.6-2.6Z" />
    <path d="m7.5 19-1.5-1.5M10 17.5 8.3 15.8" />
  </Svg>
)

/**
 * Directive: the herald's baton with a reset arc — a control card the app
 * carries out (clear/compact the context of the targeted sessions), not a work
 * item. The circular sweep reads as "reset/economy".
 */
const IconKindDirective = (
  <Svg>
    <path d="M18.4 8.6A7 7 0 1 0 19 12" />
    <path d="M18.7 4.8v3.9h-3.9" />
  </Svg>
)

/**
 * Roadmap kind marks, coloured per kind (styles.css .kind-glyph-*) so the
 * kanban keeps its at-a-glance colour scanning despite the stroke style.
 */
export const GLYPH_KINDS: Record<RoadmapKind, React.JSX.Element> = {
  feature: <span className="kind-glyph kind-glyph-feature">{IconKindFeature}</span>,
  bug: <span className="kind-glyph kind-glyph-bug">{IconKindBug}</span>,
  debt: <span className="kind-glyph kind-glyph-debt">{IconKindDebt}</span>,
  idea: <span className="kind-glyph kind-glyph-idea">{IconKindIdea}</span>,
  chore: <span className="kind-glyph kind-glyph-chore">{IconKindChore}</span>,
  directive: <span className="kind-glyph kind-glyph-directive">{IconKindDirective}</span>
}

/** Semantic badge glyphs (identity/state marks, not clickable actions). */

// --- Notification channels (PLAN N3/N4) ---
// Identity marks for the three delivery channels. Deliberately NOT brand
// logos: the set is one hand-drawn Greek family, and importing three
// third-party marks would break it (and their trademark rules). Each channel
// gets the Greek metaphor for how ITS kind of message travels.

/** Talaria — Hermes' winged sandal: the swift personal messenger (Telegram). */
const IconTalaria = (
    <Svg>
      <path d="M6 17h9a3 3 0 0 0 3-3V9" />
      <path d="M6 17l-2 3h11" />
      <path d="M18 9c-2.2 0-3.5-1.2-3.5-3 0-1.2.8-2 2-2 1.4 0 2.4 1.1 2.6 2.6L19.5 9z" />
      <path d="M3 8h5M2 11h6" />
    </Svg>
)

/** Salpinx — the herald's trumpet that calls a whole assembly (Discord). */
const IconSalpinx = (
    <Svg>
      <path d="M4 10.5v3a1 1 0 0 0 1 1h2l7 3.5V6L7 9.5H5a1 1 0 0 0-1 1z" />
      <path d="M17 9.5a4 4 0 0 1 0 5" />
      <path d="M19.5 7.5a7 7 0 0 1 0 9" />
    </Svg>
)

/** Phryktoria — the fire-beacon chain that carried news across Greece (app). */
const IconBeacon = (
    <Svg>
      <path d="M12 3c1.6 2 2.4 3.4 2.4 4.6A2.4 2.4 0 0 1 12 10a2.4 2.4 0 0 1-2.4-2.4C9.6 6.4 10.4 5 12 3z" />
      <path d="M8 13h8l-1 8H9l-1-8z" />
      <path d="M6.5 13h11" />
      <path d="M5 6.5 3.5 5M19 6.5 20.5 5" />
    </Svg>
)

export const GLYPH_BADGES = {
  laurel: IconLaurel,
  scales: IconScales,
  swords: IconSwords,
  clepsydra: IconClepsydra,
  profile: IconProfile,
  torchLit: IconTorchLit,
  torchOut: IconTorchOut,
  lock: IconLock,
  warning: IconWarning,
  gear: IconGear,
  capsa: IconCapsa,
  clip: IconClip,
  archive: IconArchive,
  lift: IconLift,
  star: IconStar,
  starFilled: IconStarFilled,
  checkboxOn: IconCheckboxOn,
  checkboxOff: IconCheckboxOff,
  talaria: IconTalaria,
  salpinx: IconSalpinx,
  beacon: IconBeacon
}

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
  record: IconRecord,
  target: IconTarget,
  erase: IconErase,
  code: IconCode,
  external: IconExternal,
  folder: IconFolder,
  check: IconCheck,
  wand: IconWand
}

/** Every place a rail glyph can appear: the rail views + the rail extras. */
export type GlyphName = DeckView | 'companion' | 'inbox' | 'usage' | 'more'

export const GLYPHS: Record<GlyphName, React.JSX.Element> = {
  home: IconTemple,
  agents: IconMask,
  browser: IconSphere,
  files: IconScroll,
  git: IconBranch,
  roadmap: IconLabyrinth,
  graph: IconConstellation,
  worktrees: IconOlive,
  sandbox: IconPithos,
  journal: IconVolumen,
  companion: IconWingedTablet,
  inbox: IconCaduceus,
  usage: IconAmphora,
  more: IconMore
}
