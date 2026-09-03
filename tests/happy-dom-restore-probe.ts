// Rejouée dans un processus bun neuf : l'ordre d'exécution des fichiers de test
// n'est pas garanti (des versions de bun trient différemment), donc une sonde
// partageant le processus ne peut rien affirmer sur l'état initial des globals.
// Le contrat : le texte 'PROBE ok' sur stdout, code de sortie 0 en cas de
// succès, un code distinct par échec pour rester lisible sans relire ce
// fichier.
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
