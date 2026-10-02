import type { SupportedLocale } from './i18n'

export interface AvatarTrayCounters {
  working: number
  waiting: number
  unread: number
}

interface AvatarTrayCopy {
  counters: (counters: AvatarTrayCounters) => string
  project: (projectDir: string) => string
  broker: (brokerUrl: string) => string
  focusDeck: string
  showAvatar: string
  lockPosition: string
  alwaysOnTop: string
  motion: string
  motionContinuous: string
  motionTransitions: string
  motionNone: string
  size: string
  sizeSmall: string
  sizeMedium: string
  sizeLarge: string
  doNotDisturb: string
  dndOff: string
  dnd30m: string
  dnd1h: string
  dndTomorrow: string
  quit: string
}

export const AVATAR_TRAY_COPY = {
  en: {
    counters: ({ working, waiting, unread }) => `${working} working | ${waiting} waiting | ${unread} unread`,
    project: (projectDir) => `Project: ${projectDir}`,
    broker: (brokerUrl) => `Broker: ${brokerUrl}`,
    focusDeck: 'Bring Deck to front',
    showAvatar: 'Show the avatar',
    lockPosition: 'Lock position',
    alwaysOnTop: 'Always on top',
    motion: 'Motion',
    motionContinuous: 'Continuous',
    motionTransitions: 'Transitions only',
    motionNone: 'None',
    size: 'Size',
    sizeSmall: 'Small',
    sizeMedium: 'Medium',
    sizeLarge: 'Large',
    doNotDisturb: 'Do not disturb',
    dndOff: 'Off',
    dnd30m: '30 minutes',
    dnd1h: '1 hour',
    dndTomorrow: 'Until tomorrow',
    quit: 'Quit Avatar'
  },
  fr: {
    counters: ({ working, waiting, unread }) => `${working} au travail | ${waiting} en attente | ${unread} ${unread < 2 ? 'non lu' : 'non lus'}`,
    project: (projectDir) => `Projet : ${projectDir}`,
    broker: (brokerUrl) => `Broker : ${brokerUrl}`,
    focusDeck: 'Afficher le Deck au premier plan',
    showAvatar: "Afficher l'avatar",
    lockPosition: 'Verrouiller la position',
    alwaysOnTop: 'Toujours au premier plan',
    motion: 'Animation',
    motionContinuous: 'Continue',
    motionTransitions: 'Transitions seulement',
    motionNone: 'Aucune',
    size: 'Taille',
    sizeSmall: 'Petite',
    sizeMedium: 'Moyenne',
    sizeLarge: 'Grande',
    doNotDisturb: 'Ne pas déranger',
    dndOff: 'Désactivé',
    dnd30m: 'Pendant 30 minutes',
    dnd1h: 'Pendant 1 heure',
    dndTomorrow: "Jusqu'à demain",
    quit: "Quitter l'avatar"
  }
} as const satisfies Record<SupportedLocale, AvatarTrayCopy>
