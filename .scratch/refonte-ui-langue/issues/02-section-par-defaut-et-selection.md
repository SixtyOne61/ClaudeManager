# Section par défaut et « tout sélectionner » dans une section

Status: resolved

## Ce qu'on veut

Que « Sans section » se comporte comme une vraie section (la section par défaut), et pouvoir sélectionner toutes les conversations d'une section d'un clic. Code concerné : `src/components/ProjectView.tsx` (zone « Sans section » vers la ligne 70 et 502, sélection vers la ligne 204), `src/sections.ts`.

## Comportement attendu

### Section par défaut
- Même en-tête que les autres sections : repli, bouton +, zone de dépôt, compteur.
- Renommable ; nom par défaut « Général ».
- Réordonnable parmi les sections (elle n'est plus forcément en haut).
- Jamais supprimable (pas d'action « Supprimer » sur elle). Supprimer une autre section renvoie ses conversations dans la section par défaut (message de confirmation mis à jour avec son nom).
- Données : les conversations gardent `sectionId = null`. On stocke en plus dans la config du projet le nom de la section par défaut et sa position dans l'ordre. Absents = « Général », en tête. Pas de migration.
- Mettre à jour les textes qui citent « Sans section » (bouton principal, info-bulles, fenêtre worktree…).

### Tout sélectionner
- Case à cocher à trois états dans l'en-tête de chaque section, y compris la section par défaut : vide / partielle / pleine.
- Clic sur une case vide ou partielle : **ajoute** toutes les conversations de la section à la sélection en cours. Clic sur une case pleine : les retire.
- Marche aussi sur une section repliée.
- La case apparaît au survol de l'en-tête, et reste visible en permanence dès qu'une sélection est en cours.
- Les actions de sélection multiple existantes (déplacer, couleur, archiver…) s'appliquent normalement.

## Vérifications

- Projet sans aucune section : affichage sobre (une seule section « Général »).
- Renommer la section par défaut, la déplacer, supprimer une autre section : les conversations reviennent bien dedans.
- Sélectionner deux sections entières puis désélectionner une conversation : la case de sa section passe à « partielle ».

## Comments

Fait :
- `src/sections.ts` : entrée réservée `DEFAULT_SECTION_ID = "default"` dans `ProjectPrefs.sections` (nom, couleur, repli, position ; `conversationIds` toujours vide). `projectSections` l'ajoute en tête quand elle est absente, donc renommer, colorer, replier et réordonner réutilisent les fonctions existantes ; `deleteSection` la refuse ; `storedSectionId` ramène `"default"` à `null` pour ranger une conversation ; `groupBySection` ne renvoie plus que `sections` (la section par défaut reçoit les conversations non rangées). Aucun changement côté Rust (même forme de `Section`).
- `ProjectView` et panneau Conversations de la barre latérale : plus de zone « Sans section », la section par défaut a l'en-tête des autres, sans bouton Supprimer. Projet sans conversation ni autre section : message « Aucune conversation » au lieu d'une section vide.
- Case à trois états (`SectionCheck`) dans l'en-tête des sections de la vue projet : ajoute ou retire toutes les conversations de la section (repliée comprise) ; visible au survol, et en permanence pendant une sélection.
- README mis à jour.
