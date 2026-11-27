# Propositions : stockage, rattachement, seuil, question et réglages (backend)

Status: resolved

## Ce qu'on veut

Le backend garde les propositions de skills et fait tous les calculs, testés en Rust.

## Comportement attendu

- **Module `src-tauri/src/skills.rs`.** Il gère le fichier `skill-proposals.json` (écriture atomique) et contient :
  - la question de l'analyse de fin de conversation (skills existants via `commands_list::discover`, propositions connues, contrat JSON) ;
  - la lecture de la réponse (bloc JSON dans la dernière réponse, via `handoff::last_reply`) ;
  - le rattachement à une proposition ou la création d'une nouvelle ;
  - la purge au-delà de X jours ;
  - le calcul « rappel dû » et la portée proposée ;
  - le premier message de la conversation de création.
- **Projet d'une occurrence :** pour un worktree, on prend le dossier parent (`worktrees::detect`).
- **Réglages :** `Config.skills = { enabled, windowDays, threshold }`, avec pour défauts `true`, 7 et 3.
- **Commandes Tauri :**
  - `skills_analysis_prompt` ;
  - `skills_record` ;
  - `skills_list` (propositions, compte dans la fenêtre, rappel dû) ;
  - `skills_set_status` ;
  - `skills_mark_reviewed` ;
  - `skills_creation_message`.

## Vérifications

- Tests unitaires de la lecture du verdict, du rattachement (y compris refusée ou créée), de la purge, du seuil, du rappel dû et de la portée.

## Comments

Fait : `src-tauri/src/skills.rs` (9 tests), `SkillSettings` dans `config.rs`, commandes `skills_*` dans `lib.rs`. Les propositions refusées ou créées sont aussi envoyées dans la question, pour ne pas être reproposées. Les identifiants sont courts (`p1`, `p2`…) pour que l'agent les recopie sans erreur.
