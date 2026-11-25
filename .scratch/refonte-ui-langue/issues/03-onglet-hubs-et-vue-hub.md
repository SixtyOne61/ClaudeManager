# Onglet Hubs dans la barre latérale et vue Hub principale

Status: resolved

## Ce qu'on veut

Faire des hubs une vue de la barre latérale au même niveau que Projets et Conversations, et afficher un hub dans la zone principale comme un projet, à la place de l'onglet de hub actuel.

État actuel : `SidebarView = "projects" | "conversations"` (`src/components/Sidebar.tsx:103`), bloc `HubsBlock` (`src/components/Hubs.tsx`) en tête des deux vues. `HubView` s'ouvre comme un onglet dans la barre d'onglets du terminal (`HUB_TAB_PREFIX`, `hubTabId`, `shownHub` dans `App.tsx`). `Selection` vaut `project | archives` (`Sidebar.tsx:65`).

## Comportement attendu

### Barre latérale
- Trois onglets : **Projets | Conversations | Hubs** (préférence `sidebarView` étendue). Barre latérale réduite : troisième icône.
- L'onglet Hubs liste les hubs actifs, chacun dépliable sur ses membres (pastille d'état, titre, rôle, projet) avec compteurs et 💡. Il contient aussi le bouton « + Hub », le dépôt d'une conversation sur un hub et les actions de survol (renommer, couleur, archiver, supprimer, rôle, retirer du hub).
- Le bloc des hubs **disparaît** des onglets Projets et Conversations. L'icône 🔗 reste sur les conversations membres. Le glisser-déposer vers un hub se fait depuis l'onglet Hubs, ou par « Ajouter à un hub… ».
- Clic sur un membre : ouvre la conversation, comme aujourd'hui.

### Vue Hub principale
- Clic sur le nom d'un hub : `Selection = { kind: "hub"; id }`, vue Hub dans la zone principale, comme `ProjectView`.
- Contenu : en-tête (nom, couleur, actions dont « + Exécutant »), liste des membres présentée comme les lignes d'une vue Projet (pastille, titre, rôle, projet, date), puis le fil des messages entre conversations (repliable).
- Suppression de l'onglet de hub dans la barre d'onglets du terminal (`HUB_TAB_PREFIX` et ce qui en dépend). Les suggestions et actions qui ouvraient cet onglet (par exemple la suggestion de hub après un échange) ouvrent maintenant la vue Hub.
- Archiver ou supprimer le hub affiché : retour à une sélection valide.

## Vérifications

- Mode dev (`src/devMock.ts`) : hub fictif visible dans l'onglet Hubs, vue Hub correcte.
- Les liens « ouvrir le hub » existants mènent à la vue principale.

## Comments

Fait :
- `Selection` gagne `{ kind: "hub"; id }`. `openHub` sélectionne le hub (zone principale) ; plus d'onglet de hub dans `TerminalTabBar` (`HUB_TAB_PREFIX`, `hubTabId` supprimés). Le premier onglet de la barre devient « Hub » quand un hub est affiché, et ouvrir une conversation membre garde le hub sélectionné. Hub archivé ou supprimé : sélection vidée.
- Barre latérale : onglets Projets | Conversations | Hubs (+ icône dans la barre réduite). `HubsPanel` (Hubs.tsx) : « + Hub », hubs dépliables, hub affiché surligné, membres glissables d'un hub à l'autre (`m:<id>` → `hub:<id>`, via `dropOnHub`). Le bloc des hubs et le dépôt d'une conversation sur un hub ont quitté les onglets Projets et Conversations (« Ajouter à un hub… » reste).
- `HubView` : actions du hub dans l'en-tête (`HubHeaderActions` partagé avec la barre latérale), membres façon vue projet (ligne cliquable, projet en gras à sa couleur, date relative, rôle et « Retirer » au survol via `HubMemberControls`), fil des messages repliable.
