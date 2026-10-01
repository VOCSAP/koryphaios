import { expect, test } from 'bun:test'
import { avatarFaceCopy } from '../desktop/src/main/avatar-face-copy.ts'
import { AvatarState, type AvatarDeckCounters, type AvatarDeckStatus, type AvatarFace, type AvatarSummary } from '../desktop/src/shared/avatar-state.ts'
import { SUPPORTED_LOCALES } from '../desktop/src/main/i18n.ts'

const ZERO: AvatarDeckCounters = { working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 }

function deck(patch: Partial<AvatarDeckStatus> = {}): AvatarDeckStatus {
  return {
    identity: { deckRunId: 'deck-1', broker_url: 'https://broker.test' },
    counters: { ...ZERO },
    unread: 0,
    suspect: false,
    brokerReachable: true,
    torchOut: false,
    ...patch
  }
}

function summary(face: AvatarFace, patch: Partial<AvatarSummary> = {}): AvatarSummary {
  return { face, counters: { ...ZERO }, unread: 0, decks: [deck()], ...patch }
}

const SEVEN: Record<AvatarFace, AvatarSummary> = {
  panne: summary('panne', { decks: [deck({ torchOut: true }), deck({ torchOut: true }), deck()] }),
  reclame: summary('reclame', { counters: { ...ZERO, waiting: 3 } }),
  perdu: summary('perdu', { counters: { ...ZERO, exited: 3, rateLimited: 4 } }),
  courrier: summary('courrier', { unread: 3 }),
  travaille: summary('travaille', { counters: { ...ZERO, working: 3 } }),
  endormi: summary('endormi', { decks: [deck(), deck(), deck()] }),
  seul: summary('seul', { decks: [] })
}

test('every face has a distinct non-empty English and French copy carrying its count', () => {
  for (const [face, input] of Object.entries(SEVEN) as [AvatarFace, AvatarSummary][]) {
    const en = avatarFaceCopy(input, 'en')
    const fr = avatarFaceCopy(input, 'fr')
    expect(en.title.length, `${face} en title`).toBeGreaterThan(0)
    expect(fr.title.length, `${face} fr title`).toBeGreaterThan(0)
    expect(fr.title, `${face} fr must not reuse the English title`).not.toBe(en.title)
    for (const copy of [en, fr]) {
      expect(copy.ariaLabel, `${face} ariaLabel names the title`).toContain(copy.title)
      expect(copy.ariaLabel, `${face} ariaLabel adds context`).not.toBe(copy.title)
      if (face !== 'seul') expect(copy.title, `${face} title carries its count`).toMatch(/\b[2-4]\b/)
    }
  }
  expect(SUPPORTED_LOCALES).toEqual(['en', 'fr'])
})

test('each face reads its own counter, not a neighbour', () => {
  expect(avatarFaceCopy(SEVEN.panne, 'en').title).toBe('2 Decks are not responding')
  expect(avatarFaceCopy(SEVEN.reclame, 'en').title).toBe('3 sessions are waiting for you')
  expect(avatarFaceCopy(SEVEN.perdu, 'en').title).toBe('3 sessions stopped, 4 sessions rate-limited')
  expect(avatarFaceCopy(SEVEN.courrier, 'en').title).toBe('3 unread messages')
  expect(avatarFaceCopy(SEVEN.travaille, 'en').title).toBe('3 sessions working')
  expect(avatarFaceCopy(SEVEN.endormi, 'en').title).toBe('All quiet on 3 Decks')
  expect(avatarFaceCopy(SEVEN.seul, 'fr')).toEqual({ title: 'Aucun Deck attaché', ariaLabel: 'Avatar Koryphaios : Aucun Deck attaché' })
})

test('plural follows each language: English singular at 1 only, French singular at 0 and 1', () => {
  const working = (count: number) => summary('travaille', { counters: { ...ZERO, working: count } })
  expect(avatarFaceCopy(working(0), 'en').title).toBe('0 sessions working')
  expect(avatarFaceCopy(working(1), 'en').title).toBe('1 session working')
  expect(avatarFaceCopy(working(2), 'en').title).toBe('2 sessions working')
  expect(avatarFaceCopy(working(0), 'fr').title).toBe('0 session au travail')
  expect(avatarFaceCopy(working(1), 'fr').title).toBe('1 session au travail')
  expect(avatarFaceCopy(working(2), 'fr').title).toBe('2 sessions au travail')
  expect(avatarFaceCopy(summary('reclame', { counters: { ...ZERO, waiting: 1 } }), 'fr').title).toBe('1 session vous attend')
  expect(avatarFaceCopy(summary('endormi'), 'fr').title).toBe('Tout est calme sur 1 Deck')
})

test('every face reads naturally in French at one and at two', () => {
  const at = (count: number): Record<AvatarFace, AvatarSummary> => ({
    panne: summary('panne', { decks: Array.from({ length: count }, () => deck({ torchOut: true })) }),
    reclame: summary('reclame', { counters: { ...ZERO, waiting: count } }),
    perdu: summary('perdu', { counters: { ...ZERO, exited: count } }),
    courrier: summary('courrier', { unread: count }),
    travaille: summary('travaille', { counters: { ...ZERO, working: count } }),
    endormi: summary('endormi', { decks: Array.from({ length: count }, () => deck()) }),
    seul: summary('seul', { decks: [] })
  })
  const one = at(1)
  const two = at(2)
  expect(avatarFaceCopy(one.panne, 'fr').title).toBe('1 Deck ne répond plus')
  expect(avatarFaceCopy(two.panne, 'fr').title).toBe('2 Decks ne répondent plus')
  expect(avatarFaceCopy(one.reclame, 'fr').title).toBe('1 session vous attend')
  expect(avatarFaceCopy(two.reclame, 'fr').title).toBe('2 sessions vous attendent')
  expect(avatarFaceCopy(one.perdu, 'fr').title).toBe('1 session arrêtée')
  expect(avatarFaceCopy(two.perdu, 'fr').title).toBe('2 sessions arrêtées')
  expect(avatarFaceCopy(one.courrier, 'fr').title).toBe('1 message non lu')
  expect(avatarFaceCopy(two.courrier, 'fr').title).toBe('2 messages non lus')
  expect(avatarFaceCopy(one.travaille, 'fr').title).toBe('1 session au travail')
  expect(avatarFaceCopy(two.travaille, 'fr').title).toBe('2 sessions au travail')
  expect(avatarFaceCopy(one.endormi, 'fr').title).toBe('Tout est calme sur 1 Deck')
  expect(avatarFaceCopy(two.endormi, 'fr').title).toBe('Tout est calme sur 2 Decks')
  expect(avatarFaceCopy(one.seul, 'fr').title).toBe('Aucun Deck attaché')
  expect(avatarFaceCopy(two.seul, 'fr').title).toBe('Aucun Deck attaché')
})

test('every face AvatarState produces gets a title carrying the counter that face reports', () => {
  const brokerA = 'https://a.test'
  const brokerB = 'https://b.test'
  const produce = (decks: { broker: string; counters?: Partial<AvatarDeckCounters>; unread?: number }[], unreachable: string[] = []) => {
    const state = new AvatarState({ now: () => 1_000 })
    decks.forEach((input, index) =>
      state.receiveSnapshot({
        identity: { deckRunId: `deck-${index}`, broker_url: input.broker },
        counters: { ...ZERO, ...input.counters },
        unread: input.unread ?? 0
      })
    )
    for (const broker of unreachable) state.setBrokerReachable(broker, false)
    return state.summary()
  }
  const busy = { working: 3, idle: 5 }
  const cases: [AvatarFace, AvatarSummary, number][] = [
    ['seul', produce([]), 0],
    ['panne', produce([{ broker: brokerA, counters: { waiting: 5 } }, { broker: brokerA }, { broker: brokerB }], [brokerA]), 2],
    ['reclame', produce([{ broker: brokerA, counters: { ...busy, waiting: 5, exited: 2 }, unread: 4 }]), 5],
    ['perdu', produce([{ broker: brokerA, counters: { ...busy, exited: 2 }, unread: 4 }]), 2],
    ['courrier', produce([{ broker: brokerA, counters: busy, unread: 4 }]), 4],
    ['travaille', produce([{ broker: brokerA, counters: busy }]), 3],
    ['endormi', produce([{ broker: brokerA, counters: { idle: 5 } }, { broker: brokerB }, { broker: brokerB }]), 3]
  ]
  for (const [face, produced, count] of cases) {
    expect(produced.face, `AvatarState did not reach ${face}`).toBe(face)
    for (const locale of SUPPORTED_LOCALES) {
      const { title } = avatarFaceCopy(produced, locale)
      expect(title.length, `${face} ${locale} title`).toBeGreaterThan(0)
      if (face !== 'seul') expect(title, `${face} ${locale} title must carry its own counter ${count}`).toMatch(new RegExp(`(^|\\D)${count}(\\D|$)`))
    }
  }
})

test('perdu names only the causes that are present', () => {
  expect(avatarFaceCopy(summary('perdu', { counters: { ...ZERO, exited: 1 } }), 'fr').title).toBe('1 session arrêtée')
  expect(avatarFaceCopy(summary('perdu', { counters: { ...ZERO, rateLimited: 2 } }), 'fr').title).toBe('2 sessions limitées par le quota')
  expect(avatarFaceCopy(summary('perdu', { counters: { ...ZERO, rateLimited: 1 } }), 'en').title).toBe('1 session rate-limited')
})
