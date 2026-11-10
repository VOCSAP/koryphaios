// Small SVG ring next to a session row's model badge: how full the tile's
// context window is, read straight from SessionRuntime.liveStatus. Geometry/severity live in ../context-ring.ts (pure, no DOM)
// so they stay bun-testable; this component only turns that math into markup.

import { useT } from '../i18n'
import { clampPct, formatTokens, ringDash, ringSeverity } from '../context-ring'

const SIZE = 13
const CENTER = SIZE / 2
const RADIUS = 5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function ContextRing({
  pct,
  contextWindow,
  model,
  unavailable = false
}: {
  pct: number | null
  contextWindow: number | null
  /** Named in the label: the row hides its model badge when narrow, the ring stays. */
  model?: string
  /** The tile reports no context at all (no statusLine yet, sandbox, non-Claude). */
  unavailable?: boolean
}): React.JSX.Element {
  const t = useT()
  if (unavailable) {
    const label = t('sidebar.contextRingUnavailable')
    // Track plus a diagonal bar: an empty track alone would read as a measured 0%.
    return (
      <svg
        className="context-ring context-ring-unavailable"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <circle className="context-ring-track" cx={CENTER} cy={CENTER} r={RADIUS} />
        <line className="context-ring-bar" x1={3} y1={10} x2={10} y2={3} />
      </svg>
    )
  }
  const severity = ringSeverity(pct)
  const { dasharray, dashoffset } = ringDash(pct, CIRCUMFERENCE)
  const fill =
    pct === null
      ? t('sidebar.contextRingUnknown')
      : contextWindow !== null
        ? t('sidebar.contextRingTitle', {
            pct: Math.round(clampPct(pct)),
            tokens: formatTokens(contextWindow)
          })
        : t('sidebar.contextRingTitlePctOnly', { pct: Math.round(clampPct(pct)) })
  const label = model ? `${model} · ${fill}` : fill
  // The scope sentence is for the hover tooltip; read aloud on every row it is noise.
  const tooltip = `${label}. ${t('sidebar.contextRingScope')}`

  return (
    <svg
      className={`context-ring context-ring-${severity}`}
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={label}
    >
      <title>{tooltip}</title>
      <circle className="context-ring-track" cx={CENTER} cy={CENTER} r={RADIUS} />
      <circle
        className="context-ring-fill"
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        strokeDasharray={dasharray}
        strokeDashoffset={dashoffset}
        transform={`rotate(-90 ${CENTER} ${CENTER})`}
      />
    </svg>
  )
}
