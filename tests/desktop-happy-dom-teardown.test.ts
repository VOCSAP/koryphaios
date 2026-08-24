// Card 526665f7. Un fichier de test qui appelle `GlobalRegistrator.register()`
// prend DEUX choses au processus, et doit rendre les deux :
//
//  1. les GLOBALS. bun execute tous les fichiers de test dans un seul
//     processus, donc `globalThis.fetch` reste celui de happy-dom pour tous
//     les fichiers suivants. Ce fetch la applique la politique de meme
//     origine, celui de bun ne l'applique pas : chaque suite ulterieure qui
//     parle a un serveur qu'elle vient de lancer sur 127.0.0.1 est refusee en
//     "Cross-Origin Request Blocked" puis expire a 30 ou 60 s. Mesure : la
//     suite complete passait de 1 echec en 166 s a 19 echecs, 11 erreurs et
//     961 s, avec 20 404 lignes de refus, sans qu'AUCUN des echecs
//     supplementaires ne soit dans un fichier du lot fautif.
//
//  2. le SLOT. Le registrator garde un drapeau interne : tant qu'il est a
//     true, tout autre `register()` leve "Happy DOM has already been globally
//     registered". Restaurer les globals a la main ne rend PAS le slot, et
//     c'est pourquoi la restauration de descripteurs n'est pas acceptee ici
//     comme teardown.
//
// La lecon de forme, et la raison d'etre de cette garde : L'ORDRE D'EXECUTION
// DES FICHIERS DE TEST N'EST PAS GARANTI. Toute propriete qui tient parce
// qu'un fichier passe avant un autre tient par accident.
//
// Card 0bbac537 (2026-08-24) : l'appariement TEXTUEL register()/unregister()
// que cette garde faisait auparavant ne protege PAS contre la vraie panne
// mesuree. `tests/desktop-tile-area.test.ts` apparie parfaitement son
// mock.module() (aucun `unregister()` en jeu, ce marqueur-la n'a pas de
// contrepartie textuelle) et aurait ete invisible a ce controle ; le vrai
// declencheur etait `tests/desktop-inbox-sender-dom.test.ts`, qui meurt AU
// CHARGEMENT (une SyntaxError d'import ESM), donc APRES son propre
// `GlobalRegistrator.register()` et AVANT que son `afterAll` -- ou tout
// `unregister()` textuellement present plus bas dans le fichier -- ne
// puisse tourner. Le texte du fichier ment : il "a" un unregister(), il ne
// l'execute jamais. La garde teste maintenant la consequence pratique, pas
// la forme du texte : AUCUN fichier porteur d'un marqueur de contamination
// (GlobalRegistrator.register( ou mock.module() -- memes marqueurs que
// scripts/pure-module-partition.ts) ne doit se trouver dans l'ensemble
// PROPRE que ce module calcule, celui que scripts/partition-pure-tests.ts
// joue en un seul processus partage. C'est la garantie qui compte : peu
// importe si le texte s'appaire, un fichier marque qui finit dans le lot
// partage rouvre exactement la chaine de contamination ci-dessus.
//
// Cette garde parcourt l'arbre au lieu de nommer des fichiers, parce que le
// prochain fautif n'existe pas encore. Les deux planchers sont la contre la
// maniere dont ce genre de garde echoue OUVERT : un parcours qui ne trouve
// plus rien reste vert sur l'ensemble vide.
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
