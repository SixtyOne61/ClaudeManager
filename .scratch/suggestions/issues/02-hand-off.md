# Hand off

Status: resolved
Blocked by: 01

## Ce qu'on veut

Un clic sur **Hand off** passe le relais de la conversation à une nouvelle conversation du même projet, qui démarre avec un résumé de passation.

## Comportement attendu

- Le bouton (bandeau de la suggestion, et menu de la conversation, même sous le seuil) n'est actif que si la conversation est *à toi*. Sinon il est grisé avec l'explication « Disponible quand l'agent a fini son tour ».
- Déroulé :
  1. L'app tape dans le terminal intégré de la conversation une consigne de résumé de passation (texte par défaut ci-dessous, modifiable dans les réglages). La consigne est visible dans la conversation, comme un message de l'utilisateur.
  2. Elle attend la fin du tour (état *à toi*) et lit la dernière réponse de l'agent dans le `.jsonl`. Aucun fichier n'est écrit, donc aucune permission demandée.
  3. Elle crée une nouvelle conversation dans le même dossier (même worktree le cas échéant), avec ce résumé comme premier message.
  4. La suite prend la section et la couleur de la parente ; la parente est archivée. On garde le lien dans `config.json` (parente → suite).
- La suite affiche en tête un lien « ← Suite de *nom de la parente* » qui ouvre la parente (dans les archives). La parente affiche « Suite : *nom* → ».
- Si l'utilisateur annule (bouton dans un état « Hand off en cours… ») ou si la réponse est vide, rien n'est créé ni archivé.

Consigne par défaut :

> Rédige un résumé de passation pour une nouvelle conversation qui reprendra ce travail sans voir celle-ci : objectif, état actuel, décisions prises et pourquoi, fichiers touchés, points en suspens, prochaines étapes. Réponds uniquement par ce résumé, en Markdown.

## Vérifications

- Tests de l'extraction de la dernière réponse et de la mise à jour de l'organisation (section, couleur, archivage, lien).

## Comments

Fait :

- **Déroulé** (`src/handoff.ts`, conduit par `startHandoff` dans `App.tsx`) : `requestSummary` tape la consigne (`sendMessage`), attend « en cours » puis « à toi » (hooks), puis lit la réponse avec la commande `handoff_summary` (relue jusqu'à 5 fois si la dernière ligne tarde). La suite est créée dans le même dossier (même worktree, `cwd` de la parente) par `startNewConversation` (titre provisoire « Suite de … »), `sendWhenReady` lui tape son premier message après le hook `SessionStart`. Ensuite seulement : terminal de la parente arrêté, onglet fermé, commande `handoff_finish` (archivage de la parente, avec quelques nouvelles tentatives si le fichier est encore verrouillé, puis organisation). Annulation (« Annuler » du bandeau « Hand off en cours… », qui interrompt l'agent s'il rédige encore), réponse vide, erreur d'API ou terminal fermé : rien n'est créé ni archivé.
- **Bouton** : bandeau « Contexte rempli » (gestionnaire fourni par `TerminalView`, qui reçoit `onHandoff`), barre d'outils de la conversation, et icône « poignée de main » sur la ligne de la conversation dans la vue du projet (il n'existe pas de menu contextuel de conversation ; `ConversationActions.tsx` affiche les actions de l'agent). Grisé avec « Disponible quand l'agent a fini son tour » sauf à l'état *à toi* (`handoffBlocker`), et « Hand off en cours… » pendant un hand off.
- **Extraction** : `handoff::last_reply` (Rust, testé) — textes de l'agent après le dernier message de l'utilisateur qui reprend la consigne (à défaut le dernier message de l'utilisateur), en ne gardant que ce qui suit sa dernière action ; rien si l'utilisateur a écrit depuis.
- **Premier message de la suite** : `handoff::first_message(parent_title, summary)` dans `src-tauri/src/handoff.rs` (une phrase de présentation, puis le résumé). C'est la fonction à enrichir (hubs).
- **Lien parente → suite** : `config.json` → `handoffLinks` (`Config::handoff_links`, `HashMap<id parente, HandoffLink { successorId, at }>`), écrit par `handoff::apply` (qui donne aussi à la suite la section de la parente, juste après elle, et sa couleur). Lecture : `handoff::successor_of` / `parent_of` (Rust), `successorOf` / `parentOf` (`src/handoff.ts`). Géré par le backend seulement (`save_config` garde la version du backend, comme les archives) ; gardé tant que l'une des deux conversations existe (`prune_conversations`). `config.json` passe en version 4.
- **Liens affichés** : barre d'outils de la conversation « ← Suite de *parente* » (ouvre les archives sur la parente) et « Suite : *nom* → » ; dans les archives, la parente affiche « Suite : *nom* → ».
- **Réglages** : section « Hand off » avec la consigne modifiable (`Config::handoff_prompt`, vide = texte par défaut `DEFAULT_HANDOFF_PROMPT`) et « Rétablir le texte par défaut ».
- Mode dev (`devMock.ts`) : la consigne reçoit un faux résumé, `handoff_summary` et `handoff_finish` simulés.
- Tests Rust : extraction (réponse finale, consigne retrouvée aux espaces près, réponse vide, message écrit depuis), lecture d'un vrai `.jsonl`, organisation (section, couleur, lien, parente archivée qui garde sa place, nettoyage du lien), configuration v4.

