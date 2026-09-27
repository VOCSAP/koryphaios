# Koryphaios -- glossaire

Un terme par objet. Les termes deja fixes par `CLAUDE.md` (Lot, Workflow,
Vague) ne sont pas repris ici ; ils ne se reutilisent pas pour autre chose.

## Deck

Une fenetre Kory : un processus, un groupe de peers, un superviseur. Son
inbox et ses approbations lui appartiennent et disparaissent avec lui.

## Avatar

Le compagnon flottant, unique par utilisateur OS sur un poste. Il agrege
l'etat des Decks qui se sont branches sur lui. Il ne spawne rien et
n'ecrit rien chez un Deck. Il survit au dernier Deck.

## Branchement

L'acte par lequel un Deck se declare a l'Avatar. Sans branchement, l'Avatar
ne voit rien du Deck. Un Deck peut refuser d'etre branche ; il ne peut pas
forcer un autre Deck a l'etre. Un Deck branche est identifie avec le broker
qu'il utilise : deux Decks peuvent viser deux brokers differents.

## Interlocuteur

Le superviseur ou le team-lead d'un Deck : les seuls peers a qui l'Avatar
parle au nom de l'operateur. Une question va au superviseur, une
instruction au team-lead s'il existe.

## Voix de l'operateur / Relais

Deux natures de message de l'Avatar vers un Interlocuteur. La **voix de
l'operateur** est le texte tape par l'humain, transmis tel quel : elle vaut
consentement. Un **relais** est un texte redige par le cerveau de l'Avatar :
il ne vaut jamais consentement.

## Palier

Une tranche livrable d'un plan de conception (Palier 0, A1, A2...). Un
Palier devient une ou plusieurs cartes ; les cartes se rangent dans un Lot.
_A eviter_ : "lot" pour une tranche de plan.
