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
//     comme teardown. Mesure : `tests/desktop-tile-area.test.ts` restaurait
//     ses globals sans rendre le slot, ce qui etait invisible tant que l'ordre
//     etait alphabetique et le faisait passer apres les autres. La CI ne trie
//     pas les fichiers de la meme facon (ordre releve : desktop-journal,
//     desktop-tile-area, desktop-graph-adapters, desktop-digest), tile-area y
//     passait donc en deuxieme et faisait echouer AU CHARGEMENT les deux
//     autres fichiers qui montent un DOM.
//
// La lecon de forme, et la raison d'etre de cette garde : L'ORDRE D'EXECUTION
// DES FICHIERS DE TEST N'EST PAS GARANTI. Toute propriete qui tient parce
// qu'un fichier passe avant un autre tient par accident.
//
// Cette garde parcourt l'arbre au lieu de nommer des fichiers, parce que le
// prochain fautif n'existe pas encore. Les deux assertions plancher sont la
// contre la maniere dont ce genre de garde echoue OUVERT : un parcours qui ne
// trouve plus rien reste vert sur l'ensemble vide.
import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const TESTS_DIR = import.meta.dir
const REPO_ROOT = join(TESTS_DIR, "..")

/** Ce fichier : il cite les deux marqueurs et se signalerait lui-meme. */
const SELF = "desktop-happy-dom-teardown.test.ts"

/** Sonde rejouee par le dernier test, dans un processus neuf. */
const PROBE = "happy-dom-restore-probe.ts"

// Tous les `.ts` du repertoire, pas seulement les `.test.ts` : un helper
// partage qui enregistrerait happy-dom prendrait le slot exactement pareil.
const sources = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".ts") && f !== SELF)

test("le parcours qui alimente cette garde voit reellement la suite", () => {
  // Plancher et non compte exact : si readdirSync rend un jour un
  // sous-ensemble (repertoire renomme, extension changee), toutes les
  // assertions ci-dessous passeraient sur rien.
  expect(sources.length).toBeGreaterThan(100)
})

test("tout fichier qui enregistre happy-dom rend le slot global", () => {
  const registrants: string[] = []
  const unpaired: string[] = []

  for (const file of sources) {
    const source = readFileSync(join(TESTS_DIR, file), "utf8")
    if (!source.includes("GlobalRegistrator.register(")) continue
    registrants.push(file)
    if (!source.includes("GlobalRegistrator.unregister(")) unpaired.push(file)
  }

  // Second plancher : un ensemble de registrants vide rendrait l'assertion
  // reelle vraie a vide, meme forme d'echec ouvert que le plancher ci-dessus.
  expect(registrants.length).toBeGreaterThanOrEqual(2)

  expect(unpaired).toEqual([])
})

test("register() remplace globalThis.fetch et unregister() le rend", () => {
  // Les deux tests ci-dessus lisent du TEXTE SOURCE : ils voient le NOM
  // `unregister(`, jamais son effet, et resteraient verts devant un appel
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
