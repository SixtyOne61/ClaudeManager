# Refonte de l'interface et choix de la langue

Vocabulaire : voir [GLOSSARY.md](../../GLOSSARY.md) (*Section*, *Hub*, *Suggestion*, *Hand off*…).

## Objectif

Un lot d'évolutions d'interface (réglages, sections, hubs), une nouvelle suggestion pour les conversations anciennes, et la traduction de l'interface dans la langue choisie par l'utilisateur.

**Les 6 tickets sortent ensemble dans une même version** : pas de release intermédiaire.

## Décisions

### Réglages façon Rider (ticket 01)
- Fenêtre plus grande : liste d'onglets à gauche (Affichage, Suggestions, Hand off, Langue), contenu à droite, défilement si besoin.
- Enregistrement immédiat comme aujourd'hui (pas de « Enregistrer / Annuler »). Le dernier onglet ouvert est mémorisé.
- Pas de champ de recherche pour l'instant.

### Section par défaut et sélection d'une section (ticket 02)
- « Sans section » devient une section comme les autres : même en-tête, repli, bouton +, dépôt par glisser, sélection.
- Elle est renommable (nom par défaut « Général ») et réordonnable, mais **jamais supprimable**. Supprimer une autre section y renvoie ses conversations.
- Données : on garde `sectionId = null`, et on stocke en plus son nom et sa position dans la config du projet. Pas de migration.
- Case à cocher à trois états dans l'en-tête de chaque section (vide / partielle / pleine). Elle **s'ajoute** à la sélection en cours (plusieurs sections possibles) et marche aussi sur une section repliée. La case apparaît au survol, et reste visible en permanence pendant une sélection.

### Hub, troisième onglet de la barre latérale (ticket 03)
- La barre latérale a trois onglets : **Projets | Conversations | Hubs**.
- L'onglet Hubs liste les hubs, chacun dépliable sur ses conversations (pastille d'état, titre, rôle, projet). On y trouve le bouton « + Hub », le glisser-déposer et les actions de survol.
- Le bloc des hubs **disparaît** des onglets Projets et Conversations. L'icône 🔗 reste sur les conversations membres.
- Un clic sur un hub ouvre la vue Hub dans la **zone principale** (`Selection` gagne `{ kind: "hub"; id }`), au même niveau que la vue Projet. Elle remplace l'actuel onglet de hub dans la barre d'onglets du terminal. On y voit le nom du hub et ses actions, la liste des membres façon vue Projet, puis le fil des messages, repliable.
- La barre latérale réduite gagne une troisième icône.

### Suggestion « conversation ancienne » (ticket 04)
- Pourquoi : le cache de contexte expire. Le premier message après une longue pause fait retraiter tout le contexte au prix fort, et le contexte peut être périmé (le code a changé depuis).
- Déclencheur : **première touche tapée** dans le terminal d'une conversation dont la dernière activité date de plus de **X** (1 h par défaut) et dont le contexte dépasse **Y %** (30 % par défaut). Rien ne se passe à la simple ouverture : on peut vouloir juste relire.
- Le bandeau ne bloque pas la frappe. Bouton d'action « Hand off », et « Ignorer » pour continuer : le bandeau ne revient plus pour cette conversation tant qu'elle reste ouverte.
- Le texte dit les choses franchement. Un hand off relit lui aussi tout le contexte, mais une seule fois, puis repart léger. Exemple : « Cette conversation date de 3 h : ton prochain message fera relire tout son contexte (45 %). Un hand off la relit une seule fois et repart léger. »
- La règle se désactive et X et Y se règlent dans l'onglet Suggestions.

### Catalogue de textes (ticket 05)
- Tous les textes de l'interface sortent du code et vont dans un catalogue de référence en français (clé → texte, avec variables `{name}`).
- Les messages que l'utilisateur voit et qui viennent du cœur Rust passent aussi par le catalogue : le cœur renvoie un code et ses paramètres, l'interface en fait le texte. Les journaux internes et les sorties techniques brutes (git…) restent tels quels.
- Les textes envoyés aux conversations (consigne de hand off, etc.) **ne sont pas traduits**.
- Les dates relatives et les nombres passent par `Intl`, dans la langue choisie.
- Pur refactoring : l'app en français ne doit pas changer.

### Traduction et onglet Langue (ticket 06)
- Traduction par `claude -p` en local (abonnement de l'utilisateur, aucune clé), avec **Sonnet**.
- Ce que tape l'utilisateur est ramené à un code standard : « anglais », « English » et « en » donnent tous `en`, affiché sous son nom natif. Si la langue n'existe pas (« klingon », « azerty »), un message d'erreur « Langue inconnue » s'affiche.
- La requête inclut le glossaire. « Hub », « Hand off » et « Worktree » restent tels quels, les autres termes sont traduits de façon constante.
- Variable cassée dans une traduction → ce texte s'affiche en français.
- Stockage : un fichier JSON par langue dans le dossier de données de l'app. Chaque texte garde une empreinte du texte français dont il est tiré. Quand une nouvelle version de l'app ajoute ou modifie des textes, seuls ceux-là sont retraduits, en arrière-plan au lancement, et s'affichent en français en attendant.
- Onglet Langue : liste des langues traduites (clic pour choisir, bouton pour supprimer), champ « Autre langue… » avec un bouton « Traduire » et une progression. Le français est la langue intégrée à l'app.

## Tickets

| Ticket | Sujet |
| --- | --- |
| 01 | Réglages façon Rider |
| 02 | Section par défaut et « tout sélectionner » dans une section |
| 03 | Onglet Hubs dans la barre latérale et vue Hub principale |
| 04 | Suggestion « conversation ancienne » |
| 05 | Catalogue de textes (refactoring) |
| 06 | Traduction via `claude -p` et onglet Langue |

Les tickets 01 à 04 sont indépendants. Le 06 dépend du 01 et du 05.

## Hors périmètre

- Recherche dans les réglages.
- Traduction des consignes envoyées à Claude.
- Hand off avec un modèle moins cher pour les conversations anciennes.
