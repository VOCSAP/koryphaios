// A file calling GlobalRegistrator.register() must restore both the globals it
// overwrites (fetch enforces same-origin in later suites otherwise) and the
// registrator's own internal slot, which a manual descriptor restore does not
// release.
// Test file execution order is not guaranteed, so any property that holds only
// because one file runs before another holds by accident.
// Textual register()/unregister() pairing is not sufficient: a file that dies
// at load (an ESM SyntaxError) never reaches its own afterAll even though the
// unregister() call is textually present. The guard instead checks that no file
// carrying a contamination marker (GlobalRegistrator.register( or
// mock.module()) ends up in the shared-process set that
// scripts/partition-pure-tests.ts actually runs.
import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { CONTAMINATION_MARKERS, EXEMPTIONS, listTestFiles, partitionTests } from "../scripts/pure-module-partition.ts"

const TESTS_DIR = import.meta.dir
const REPO_ROOT = join(TESTS_DIR, "..")

/** Ce fichier : il cite les deux marqueurs et se signalerait lui-meme. */
const SELF = "desktop-happy-dom-teardown.test.ts"

/** Sonde rejouee par le dernier test, dans un processus neuf. */
const PROBE = "happy-dom-restore-probe.ts"

// Tous les `.ts` du repertoire, pas seulement les `.test.ts` : un helper
// partage qui enregistrerait happy-dom prendrait le slot exactement pareil.
const sources = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".ts") && f !== SELF)

function carriesAMarker(file: string): boolean {
  const source = readFileSync(join(TESTS_DIR, file), "utf8")
  return CONTAMINATION_MARKERS.some((m) => source.includes(m))
}

test("le parcours qui alimente cette garde voit reellement la suite", () => {
  // Plancher et non compte exact : si readdirSync rend un jour un
  // sous-ensemble (repertoire renomme, extension changee), toutes les
  // assertions ci-dessous passeraient sur rien.
  expect(sources.length).toBeGreaterThan(100)
})

test("aucun fichier porteur d'un marqueur de contamination ne se trouve dans l'ensemble PROPRE calcule par scripts/pure-module-partition.ts", () => {
  const registrants = sources.filter(carriesAMarker)

  // Second plancher : un ensemble de registrants vide rendrait l'assertion
  // reelle vraie a vide, meme forme d'echec ouvert que le plancher ci-dessus.
  expect(registrants.length).toBeGreaterThanOrEqual(2)

  const { clean } = partitionTests(listTestFiles(TESTS_DIR), EXEMPTIONS)
  const cleanCarryingAMarker = clean.filter((file) => registrants.includes(file))
  expect(cleanCarryingAMarker).toEqual([])
})

test("mutation proof: a wrongly-clean bucket containing the diagnosed file (desktop-tile-area.test.ts) is caught", () => {
  // desktop-tile-area.test.ts is the file diagnosed in card 0bbac537 as the
  // actual trigger (mock.module() with no errorText, no unregister() ever
  // in play for that marker). It pairs cleanly under the retired textual
  // register()/unregister() check -- exactly why that check missed the real
  // defect. This shows the decisive assertion above catches it directly: a
  // "clean" bucket that (wrongly) contained this file would fail it.
  expect(carriesAMarker("desktop-tile-area.test.ts")).toBe(true)
  const wronglyClean = ["logger.test.ts", "desktop-tile-area.test.ts"]
  const registrants = sources.filter(carriesAMarker)
  const cleanCarryingAMarker = wronglyClean.filter((file) => registrants.includes(file))
  expect(cleanCarryingAMarker).toEqual(["desktop-tile-area.test.ts"])
})

test("CONTAMINATION_MARKERS est epingle a la table canonique (D4, reviewer 2026-08-24)", () => {
  // carriesAMarker() et partitionTests() lisent tous les deux la MEME
  // constante de production : retirer un marqueur retrecit `registrants` et
  // `contaminated` du meme coup, et l'intersection au-dessus reste vide par
  // construction -- vert a vide, meme forme d'echec ouvert que les deux
  // planchers. Mesure : `CONTAMINATION_MARKERS = ["mock.module("]` seul
  // laisse desktop-element-pick.test.ts et desktop-explorer-selection-dom.test.ts
  // (deux vrais GlobalRegistrator.register(), sans mock.module()) repartir
  // dans le lot partage, et cette garde restait 31 pass / 0 fail. Epingler
  // contre un litteral independant de la constante de production rend un
  // marqueur retire visible, peu importe ce que fait le reste du fichier.
  expect([...CONTAMINATION_MARKERS].sort()).toEqual(["GlobalRegistrator.register(", "mock.module("].sort())
})

test("chaque marqueur de contamination matche au moins un fichier reel sur disque (un marqueur mort ou mal orthographie serait un no-op gratuit)", () => {
  for (const marker of CONTAMINATION_MARKERS) {
    const matches = sources.filter((file) => readFileSync(join(TESTS_DIR, file), "utf8").includes(marker))
    expect(matches.length).toBeGreaterThan(0)
  }
})

test("register() remplace globalThis.fetch et unregister() le rend", () => {
  // Les tests ci-dessus lisent du TEXTE SOURCE : ils voient le NOM du
  // marqueur, jamais son effet, et resteraient verts devant un appel
  // present mais inerte (non attendu, en code mort, ou dont la restauration a
  // silencieusement cesse de fonctionner). Celui-ci exerce la vraie chose sur
  // les vrais globals, dans un processus neuf pour ne dependre d'aucun ordre.
  const run = Bun.spawnSync(["bun", join(TESTS_DIR, PROBE)], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = `${run.stdout.toString()}${run.stderr.toString()}`
  expect(output).toContain("PROBE ok")
  expect(run.exitCode).toBe(0)
})
