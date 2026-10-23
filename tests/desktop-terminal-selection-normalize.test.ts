import { expect, test } from 'bun:test'
import { normalizeTerminalSelection } from '../desktop/src/renderer/src/terminal-selection-normalize.ts'

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
