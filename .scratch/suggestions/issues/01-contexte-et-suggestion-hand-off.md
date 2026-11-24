# Contexte de chaque conversation et suggestion de hand off

Status: resolved

## Ce qu'on veut

L'app connaît le remplissage du contexte de chaque conversation et suggère un hand off au-delà d'un seuil.

## Comportement attendu

- La ligne d'état reçoit déjà `context_window.used_percentage` (`src-tauri/src/limits.rs`) avec le `session_id`. L'app enregistre cette valeur **par conversation** (dernière valeur connue, conservée quand le terminal est fermé), et la transmet à l'interface.
- Un petit moteur de suggestions côté interface : une liste de règles, chacune avec un identifiant, une fonction de détection pure (testable), un palier courant et une action. Il doit permettre d'ajouter d'autres règles sans tout refaire.
- Règle « Contexte rempli » : déclenchée à partir de 60 % par défaut ; paliers 60 → 80 → 90.
- Barre latérale : icône 💡 sur la conversation concernée, et sur son projet et sa catégorie (sans compteur).
- Onglet de la conversation : bandeau « Contexte rempli à N % : un hand off repartirait d'un contexte propre », boutons **Hand off** et **Ignorer**. Tant que le ticket 02 n'est pas fait, **Hand off** peut être absent ou désactivé.
- **Ignorer** masque la suggestion pour cette conversation jusqu'au palier suivant ; mémorisé dans `config.json`.
- Réglages : seuil (en %) et case pour couper la règle.

## Vérifications

- Tests unitaires de la règle (seuils, paliers, ignorer).
- Tests Rust de l'enregistrement par conversation.

## Comments

Fait :

- **Contexte par conversation** : la sous-commande `statusline` écrit `context\<session_id>.json` (`src-tauri/src/context.rs`) quand `context_window.used_percentage` change ; un fichier par conversation, conservé après fermeture du terminal. `since` marque le début du remplissage en cours (remis à zéro après une baisse nette, `/compact`). L'app garde les valeurs en mémoire (`ContextStore`) et surveille le dossier.
- **Moteur** : la détection est côté Rust (`src-tauri/src/suggestions.rs`, testée) : `RULES` = liste de `Rule { id, detect }`, `compute` retire règles coupées, conversations archivées et suggestions ignorées. L'app émet l'évènement `suggestions` (contexte + suggestions) à chaque changement de contexte ou de configuration ; commande `suggestions_list` au chargement. Côté interface, `src/suggestions.ts` (magasin `useSuggestions`, présentation des règles dans `SUGGESTION_RULES`, fonctions pures `dismissSuggestion`, `setRuleEnabled`, `setContextThreshold`) et `src/components/Suggestions.tsx` (icône 💡, bandeaux).
- **Règle « Contexte rempli »** : seuil réglable (60 % par défaut, borné 10-95), paliers suivants 80 et 90.
- **Barre latérale** : 💡 sur la conversation, son projet, sa catégorie (et « Non classés »), sans compteur.
- **Onglet** : bandeau « Contexte rempli à N % : un hand off repartirait d'un contexte propre », bouton **Hand off** grisé (« Pas encore disponible dans cette version ») tant qu'aucun gestionnaire n'est fourni, et **Ignorer**. Pour le ticket 02 : passer `suggestionActions={{ handoff: { run, disabledReason } }}` à `TerminalStack`/`TerminalView`.
- **Ignorer** : `ConversationPrefs.dismissedSuggestions[clé] = { level, at }` dans `config.json` (version 3) ; reparaît au palier suivant, ou si le contexte a été vidé après le clic.
- **Réglages** : nouvelle fenêtre « Réglages » (menu « … » de la barre latérale) : une case par règle, seuil du contexte.
- Mode dev sans Tauri (`devMock.ts`) : contextes fictifs, une conversation à 72 %, +9 points par message.

