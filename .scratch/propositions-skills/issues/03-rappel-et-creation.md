# Rappel, fenêtre « Skills proposés » et création d'un skill

Status: resolved
Blocked by: 01

## Ce qu'on veut

Le rappel s'affiche quand une demande est revenue assez souvent, et l'utilisateur crée le skill en un clic.

## Comportement attendu

- **Vérification :** `skills_list` est appelé au démarrage, toutes les heures et après chaque analyse. Si le rappel est dû, une icône 💡 apparaît dans la barre des onglets.
- **Fenêtre « Skills proposés » :** elle s'ouvre par l'icône ou par le menu « … » de la barre latérale.
  - Elle montre les propositions au seuil, puis celles sous le seuil.
  - Chaque proposition affiche son nom, sa description, ses occurrences (date, projet, résumé) et un choix de portée.
  - Trois boutons : **Créer**, **Refuser** et **Plus tard**.
  - Ouvrir la fenêtre appelle `skills_mark_reviewed`.
- **Créer :**
  - ouvre une nouvelle conversation dans le dossier choisi et lui tape `skills_creation_message` (via `sendWhenReady`) ;
  - fait passer la proposition en `created`.

## Vérifications

- `npm run build` et `npm run i18n:check`.

## Comments

Fait : `src/components/SkillProposals.tsx`. Le rappel est à droite de la barre des onglets, qui s'affiche même sans onglet quand il est dû. La fenêtre « Skills proposés » est aussi dans le menu « … ». « Plus tard » ferme la fenêtre. Créer ouvre une conversation titrée « Skill : nom ».
