import type { AvatarFace, AvatarSummary } from '../shared/avatar-state'
import type { AvatarViewFaceCopy } from '../shared/avatar-view'
import type { SupportedLocale } from './i18n'

interface AvatarFaceParams {
  panne: { count: number }
  reclame: { count: number }
  perdu: { exited: number; rateLimited: number }
  courrier: { count: number }
  travaille: { count: number }
  endormi: { decks: number }
  seul: Record<string, never>
}

type FaceTitles = { [F in AvatarFace]: Record<SupportedLocale, (params: AvatarFaceParams[F]) => string> }

const SINGULAR = {
  en: (count: number) => count === 1,
  fr: (count: number) => count === 0 || count === 1
} as const satisfies Record<SupportedLocale, (count: number) => boolean>

function plural(locale: SupportedLocale, count: number, one: string, other: string): string {
  return `${count} ${SINGULAR[locale](count) ? one : other}`
}

function perdu(locale: SupportedLocale, params: AvatarFaceParams['perdu'], exited: [string, string], limited: [string, string]): string {
  return [
    params.exited > 0 ? plural(locale, params.exited, ...exited) : null,
    params.rateLimited > 0 ? plural(locale, params.rateLimited, ...limited) : null
  ]
    .filter((part): part is string => part !== null)
    .join(', ')
}

const AVATAR_FACE_TITLES = {
  panne: {
    en: ({ count }) => plural('en', count, 'Deck is not responding', 'Decks are not responding'),
    fr: ({ count }) => plural('fr', count, 'Deck ne répond plus', 'Decks ne répondent plus')
  },
  reclame: {
    en: ({ count }) => plural('en', count, 'session is waiting for you', 'sessions are waiting for you'),
    fr: ({ count }) => plural('fr', count, 'session vous attend', 'sessions vous attendent')
  },
  perdu: {
    en: (params) => perdu('en', params, ['session stopped', 'sessions stopped'], ['session rate-limited', 'sessions rate-limited']),
    fr: (params) => perdu('fr', params, ['session arrêtée', 'sessions arrêtées'], ['session limitée par le quota', 'sessions limitées par le quota'])
  },
  courrier: {
    en: ({ count }) => plural('en', count, 'unread message', 'unread messages'),
    fr: ({ count }) => plural('fr', count, 'message non lu', 'messages non lus')
  },
  travaille: {
    en: ({ count }) => plural('en', count, 'session working', 'sessions working'),
    fr: ({ count }) => plural('fr', count, 'session au travail', 'sessions au travail')
  },
  endormi: {
    en: ({ decks }) => `All quiet on ${plural('en', decks, 'Deck', 'Decks')}`,
    fr: ({ decks }) => `Tout est calme sur ${plural('fr', decks, 'Deck', 'Decks')}`
  },
  seul: {
    en: () => 'No Deck attached',
    fr: () => 'Aucun Deck attaché'
  }
} as const satisfies FaceTitles

const ARIA_PREFIX = {
  en: 'Koryphaios avatar: ',
  fr: 'Avatar Koryphaios : '
} as const satisfies Record<SupportedLocale, string>

function faceTitle(summary: AvatarSummary, locale: SupportedLocale): string {
  switch (summary.face) {
    case 'panne':
      return AVATAR_FACE_TITLES.panne[locale]({ count: summary.decks.filter((deck) => deck.torchOut).length })
    case 'reclame':
      return AVATAR_FACE_TITLES.reclame[locale]({ count: summary.counters.waiting })
    case 'perdu':
      return AVATAR_FACE_TITLES.perdu[locale]({ exited: summary.counters.exited, rateLimited: summary.counters.rateLimited })
    case 'courrier':
      return AVATAR_FACE_TITLES.courrier[locale]({ count: summary.unread })
    case 'travaille':
      return AVATAR_FACE_TITLES.travaille[locale]({ count: summary.counters.working })
    case 'endormi':
      return AVATAR_FACE_TITLES.endormi[locale]({ decks: summary.decks.length })
    case 'seul':
      return AVATAR_FACE_TITLES.seul[locale]()
  }
}

export function avatarFaceCopy(summary: AvatarSummary, locale: SupportedLocale): AvatarViewFaceCopy {
  const title = faceTitle(summary, locale)
  return { title, ariaLabel: `${ARIA_PREFIX[locale]}${title}` }
}
