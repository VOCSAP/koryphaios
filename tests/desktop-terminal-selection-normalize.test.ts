import { expect, test } from 'bun:test'
import { normalizeTerminalSelection, stripBoxFrame } from '../desktop/src/renderer/src/terminal-selection-normalize.ts'

test('rejoins la commande PowerShell Claude Code coupée avec deux espaces', () => {
  const first = '  Get-CimInstance Win32_OperatingSystem | Format-Table'
  const selection = `${first}\n  -AutoSize -Wrap`

  expect(normalizeTerminalSelection(selection, first.length)).toBe(
    'Get-CimInstance Win32_OperatingSystem | Format-Table -AutoSize -Wrap'
  )
})

test('garde le saut après une barre oblique inverse', () => {
  const first = "  git commit -m 'fix a command that needs a continuation' \\"
  const selection = `${first}\n  && git push`

  expect(normalizeTerminalSelection(selection, first.length)).toBe("git commit -m 'fix a command that needs a continuation' \\\n&& git push")
})

test('garde une ligne vide', () => {
  const selection = '  first\n\n  second'

  expect(normalizeTerminalSelection(selection, 80)).toBe('first\n\nsecond')
})

test('ne traite pas une tabulation initiale comme une indentation Claude Code', () => {
  const selection = '\tfirst line\n  next line'

  expect(normalizeTerminalSelection(selection, 80)).toBe('\tfirst line\nnext line')
})

test('ne rejoint pas une sélection qui commence au milieu d’une ligne', () => {
  const selection = 'middle line\n  follow up'

  expect(normalizeTerminalSelection(selection, 80)).toBe('middle line\nfollow up')
})

test('ne rejoint aucune ligne sous la largeur minimale', () => {
  const first = `  ${'x'.repeat(37)}`
  const selection = `${first}\n  next`

  expect(normalizeTerminalSelection(selection, 39)).toBe(`${'x'.repeat(37)}\nnext`)
})

test('garde le saut à 40 cols quand la largeur utile est 38 (mutation: seuil sur cols brut)', () => {
  const first = `  ${'x'.repeat(38)}`

  expect(normalizeTerminalSelection(`${first}\n  next`, 40, { requireAgentIndent: true })).toBe(`${'x'.repeat(38)}\nnext`)
})

test('garde le saut à 41 cols quand la largeur utile est 39 (mutation: seuil sur cols brut)', () => {
  const first = `  ${'x'.repeat(38)}`

  expect(normalizeTerminalSelection(`${first}\n  next`, 41, { requireAgentIndent: true })).toBe(`${'x'.repeat(38)}\nnext`)
})

test('laisse une sortie non indentée inchangée quand l’indentation agent est requise', () => {
  const first = `${'x'.repeat(75)} last`
  const selection = `${first}\nnext`

  expect(normalizeTerminalSelection(selection, 80, { requireAgentIndent: true })).toBe(selection)
})

test('répare une commande indentée de deux espaces quand l’indentation agent est requise', () => {
  const first = `  ${'x'.repeat(73)} last`
  const selection = `${first}\n  next`

  expect(normalizeTerminalSelection(selection, 80, { requireAgentIndent: true })).toBe(`${'x'.repeat(73)} last next`)
})

test('mesure les caractères CJK en cellules terminal', () => {
  const first = `  a界界b x${'z'.repeat(32)}`

  expect(normalizeTerminalSelection(`${first}\n  y`, 42)).toBe(`a界界b x${'z'.repeat(32)} y`)
})

test('mesure les séquences emoji en cellules terminal', () => {
  const first = `  a👩‍💻👩‍💻x${'z'.repeat(28)}`

  expect(normalizeTerminalSelection(`${first}\n  y`, 42)).toBe(`a👩‍💻👩‍💻x${'z'.repeat(28)}\ny`)
})

test('retire les espaces terminaux de chaque ligne', () => {
  expect(normalizeTerminalSelection('  ls -la   \n', 80)).toBe('ls -la')
})

test('retire seulement les lignes vides en tête et en fin', () => {
  expect(normalizeTerminalSelection('\n\n  first\n\n  second\n\n', 80)).toBe('first\n\nsecond')
})

test('rejoint une URL dont le jeton remplit cols moins indent (mutation: largeur de coupure = cols)', () => {
  const first = `  https://${'a'.repeat(70)}`

  expect(normalizeTerminalSelection(`${first}\n  /x`, 80, { requireAgentIndent: true })).toBe(`https://${'a'.repeat(70)}/x`)
})

test('garde l’espace avant un jeton de cols moins indent moins un (mutation: largeur de coupure = cols)', () => {
  const first = `  https://${'a'.repeat(69)}`

  expect(normalizeTerminalSelection(`${first}\n  /x`, 80, { requireAgentIndent: true })).toBe(`https://${'a'.repeat(69)} /x`)
})

test('rejoint avec espace le mot repoussé avant une ligne non pleine', () => {
  const first = `  echo ${'x'.repeat(64)}`

  expect(normalizeTerminalSelection(`${first}\n  next`, 72)).toBe(`echo ${'x'.repeat(64)} next`)
})

const boxVertical = String.fromCodePoint(0x2502)
const framedRow = (body: string, innerWidth: number): string => `${boxVertical} ${body.padEnd(innerWidth)} ${boxVertical}`

test('retire un cadre Prosopon avec première rangée partielle', () => {
  const cols = 60
  const first = `Get-ChildItem ${'x'.repeat(40)}`
  const next = '-Recurse'
  const selection = `${framedRow(`  ${first}`, cols - 4).slice(4)}\n${framedRow(`  ${next}`, cols - 4)}`

  expect(normalizeTerminalSelection(selection, cols, { requireAgentIndent: true })).toBe(`${first} ${next}`)
})

test('laisse un cadre incomplet ou aux colonnes de fin incohérentes intact', () => {
  const cols = 60
  const inconsistentColumn = `${framedRow('  Get-ChildItem', cols - 4)}\n${boxVertical}   -Recurse ${boxVertical}`
  const missingLeft = `${framedRow('  Get-ChildItem', cols - 4)}\n${' -Recurse'.padEnd(cols - 2)} ${boxVertical}`

  expect(normalizeTerminalSelection(inconsistentColumn, cols, { requireAgentIndent: true })).toBe(inconsistentColumn)
  expect(normalizeTerminalSelection(missingLeft, cols, { requireAgentIndent: true })).toBe(missingLeft)
})

test('rejoint sans espace un mot coupé dans un cadre Prosopon', () => {
  const cols = 60
  const first = 'a'.repeat(cols - 6)
  const selection = `${framedRow(`  ${first}`, cols - 4)}\n${framedRow('  tail', cols - 4)}`

  expect(normalizeTerminalSelection(selection, cols, { requireAgentIndent: true })).toBe(`${first}tail`)
})

test('conserve les pipes ASCII dans un cadre Prosopon', () => {
  const cols = 60
  const first = `Get-Process | ${'x'.repeat(40)}`
  const next = '| Where-Object CPU -gt 100'
  const selection = `${framedRow(`  ${first}`, cols - 4).slice(4)}\n${framedRow(`  ${next}`, cols - 4)}`

  expect(normalizeTerminalSelection(selection, cols, { requireAgentIndent: true })).toBe(`${first} ${next}`)
})

test('retire une rangée encadrée complète seule (mutation: refuse rows.length < 2)', () => {
  const selection = framedRow('  Get-ChildItem', 16)

  expect(normalizeTerminalSelection(selection, 20, { requireAgentIndent: true })).toBe('Get-ChildItem')
})

test('laisse un tableau Markdown encadré intact (mutation: omet l’indentation agent)', () => {
  const table = `${framedRow(`key ${boxVertical} value`, 16)}\n${framedRow(`one ${boxVertical} two`, 16)}`

  expect(stripBoxFrame(table, 20)).toEqual({ text: table, frameWidth: 0 })
})

test('retire un cadre avec deux rangées de sélection partielles et une rangée complète alignée', () => {
  const cols = 60
  const selection = `${framedRow('  alpha', cols - 4).slice(4)}\n${framedRow('  middle', cols - 4)}\n${framedRow('  omega', cols - 4).slice(0, 12)}`

  expect(stripBoxFrame(selection, cols)).toEqual({ text: 'alpha\n  middle\n  omega', frameWidth: 4 })
})

test('laisse deux rangées partielles autour d’une complète non alignée intactes', () => {
  const text = `left ${boxVertical}\n${boxVertical} middle ${boxVertical}\n${boxVertical} right`
  const agentLike = `command ${boxVertical}\n${boxVertical}   continuation ${boxVertical}\n${boxVertical}   last`

  expect(stripBoxFrame(text, 60)).toEqual({ text, frameWidth: 0 })
  expect(stripBoxFrame(agentLike, 60)).toEqual({ text: agentLike, frameWidth: 0 })
})

test('laisse intacte une sélection sans aucune rangée encadrée complète', () => {
  const cases: Record<string, string> = {
    'deux rangées partielles': `command ${boxVertical}\n${boxVertical}   continuation`,
    'deux rangées partielles à corps indenté': `  Get-ChildItem ${boxVertical}\n${boxVertical}   -Recurse`,
    'rangée unique sans cadre': '  Get-ChildItem -Recurse',
  }

  for (const [name, text] of Object.entries(cases)) {
    expect({ name, ...stripBoxFrame(text, 60) }).toEqual({ name, text, frameWidth: 0 })
  }
})

test('laisse intact un cadre dont une rangée suivante perd sa bordure gauche, même indentée', () => {
  const cols = 60
  const text = `${framedRow('  Get-ChildItem', cols - 4)}\n${'    -Recurse'.padEnd(cols - 2)} ${boxVertical}`

  expect(stripBoxFrame(text, cols)).toEqual({ text, frameWidth: 0 })
})

test('mesure la bordure droite avec le mesureur de cellules injecté', () => {
  const cols = 20
  const wide = String.fromCodePoint(0x25b2)
  const cells = (text: string): number => [...text].length + [...text].filter((glyph) => glyph === wide).length
  const selection = framedRow(`  ${wide}${wide}`, cols - 6)

  expect(normalizeTerminalSelection(selection, cols, { stringWidth: cells })).toBe(`${wide}${wide}`)
  expect(normalizeTerminalSelection(selection, cols), 'sans mesureur injecté, la bordure droite tombe sur une autre colonne').toBe(selection)
})

test('refuse les largeurs hostiles', () => {
  const text = framedRow('  Get-ChildItem', 16)

  for (const width of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 19.5]) {
    expect(stripBoxFrame(text, width)).toEqual({ text, frameWidth: 0 })
  }
})

test('compare la bordure droite CJK en cellules terminal (mutation: row.length)', () => {
  const ascii = `${boxVertical} ${'  aa'.padEnd(10)} ${boxVertical}`
  const cjk = `${boxVertical}   界${' '.repeat(6)} ${boxVertical}`

  expect(stripBoxFrame(`${ascii}\n${cjk}`, 14)).toEqual({ text: '  aa\n  界', frameWidth: 4 })
})
