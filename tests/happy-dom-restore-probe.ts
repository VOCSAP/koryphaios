// Sonde rejouee par tests/desktop-happy-dom-teardown.test.ts dans un processus
// bun NEUF. Elle vit dans un processus separe pour une raison mesuree, pas par
// gout de l'isolation : l'ordre d'execution des fichiers de test n'est pas
// garanti (bun 1.3.13 trie alphabetiquement, la CI sur bun 1.3.14 ne trie pas),
// donc une sonde qui s'execute dans le processus partage ne peut RIEN affirmer
// sur l'etat initial des globals -- n'importe quel fichier a pu enregistrer
// happy-dom avant elle. Dans un processus neuf, l'etat de depart est connu.
//
// Codes de sortie distincts pour que l'echec soit lisible sans relire ce
// fichier. Le contrat est le texte "PROBE ok" sur stdout et le code 0.
import { GlobalRegistrator } from "@happy-dom/global-registrator"

const nativeFetch = globalThis.fetch

if (GlobalRegistrator.isRegistered) {
  console.error("PROBE: happy-dom deja enregistre dans un processus neuf")
  process.exit(2)
}

GlobalRegistrator.register()

// Porteur, pas un echauffement : si happy-dom cesse un jour de remplacer
// `fetch`, l'assertion de restauration ci-dessous devient vraie A VIDE et la
// garde entiere cesse silencieusement de vouloir dire quoi que ce soit. On
// echoue ici d'abord, en nommant la cause.
if (globalThis.fetch === nativeFetch) {
  console.error("PROBE: register() n'a pas remplace globalThis.fetch")
  process.exit(3)
}

await GlobalRegistrator.unregister()

if (globalThis.fetch !== nativeFetch) {
  console.error("PROBE: unregister() n'a pas rendu globalThis.fetch")
  process.exit(4)
}

if (GlobalRegistrator.isRegistered) {
  console.error("PROBE: unregister() n'a pas rendu le slot global")
  process.exit(5)
}

console.log("PROBE ok")
