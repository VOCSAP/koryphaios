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
  model
}: {
  pct: number | null
  contextWindow: number | null
  /** Named in the label: the row hides its model badge when narrow, the ring stays. */
  model?: string
}): React.JSX.Element {
  const t = useT()
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

  return (
    <svg
      className={`context-ring context-ring-${severity}`}
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
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
