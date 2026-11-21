# Claude Manager

Application de bureau Windows pour travailler avec **Claude Code** : on discute avec l'agent directement dans l'app, sur les mêmes conversations que Claude Desktop et le terminal, avec en plus une organisation à soi.

- **Discuter dans l'app** : chaque conversation s'ouvre dans un onglet. L'app affiche les messages et les actions de l'agent ; le vrai Claude Code tourne dans un terminal intégré, qui apparaît quand il faut valider quelque chose (permission, question, confiance dans un dossier).
- **Organiser** : catégories de projets, sections de conversations dans chaque projet, couleurs pour les catégories, projets, sections et conversations, glisser-déposer, archives et Corbeille.
- **Suivre** : une pastille indique l'état de chaque conversation (*en cours*, *action requise*, *à toi*), avec des compteurs sur les projets et les catégories.
- **Retrouver** : recherche dans le contenu de toutes les conversations, archives comprises.

Vocabulaire : [GLOSSARY.md](GLOSSARY.md). Choix d'architecture : [docs/adr](docs/adr).

## Connexion et confidentialité

L'app lance le binaire `claude` officiel, tel qu'Anthropic le fournit, dans un terminal intégré : vous vous y connectez avec votre propre abonnement. Claude Manager ne lit, ne stocke ni ne transmet jamais vos identifiants, n'utilise ni l'Agent SDK ni de clé d'API, et ne répond jamais à une demande de permission à votre place (voir [ADR 0001](docs/adr/0001-terminal-integre-plutot-que-agent-sdk.md)).

Il ne modifie ni vos réglages de Claude Code (`settings.json`) ni `~/.claude.json`.

Tout est local. La seule connexion réseau de l'app est la vérification des mises à jour, et elle n'a lieu que si vous cliquez sur **Vérifier les mises à jour** (voir plus bas). La fenêtre elle-même n'a aucun accès réseau (sa politique de sécurité l'interdit). Claude Code, lui, se connecte à Anthropic comme d'habitude.

Prérequis : Claude Code installé (`claude` dans le `PATH`).

## Fonctionnement

| Quoi | Où |
| --- | --- |
| Projets et conversations (écrits par Claude Code) | `%USERPROFILE%\.claude\projects\<chemin-encodé>\<session-id>.jsonl` (ou `%CLAUDE_CONFIG_DIR%\projects`) |
| Catégories, sections, couleurs, noms d'affichage, liste des archives | `%APPDATA%\claude-manager\config.json` |
| Hooks de suivi d'état, passés à Claude Code avec `--settings` | `%APPDATA%\claude-manager\hooks-settings.json` |
| État de chaque conversation (écrit par les hooks) | `%APPDATA%\claude-manager\state\<session-id>.json` |
| Cache des résumés de conversations (supprimable sans risque) | `%APPDATA%\claude-manager\cache.json` |
| Conversations archivées | `%APPDATA%\claude-manager\archive\<projet>\` |

- **Chemin du projet** : le nom du dossier dans `.claude\projects` est le chemin avec chaque caractère non alphanumérique remplacé par `-`, ce qui est irréversible. Le vrai chemin est lu dans le champ `cwd` des messages.
- **Worktrees** : une conversation lancée dans `<projet>\.claude\worktrees\<nom>` est rangée sous son projet, avec un badge « worktree » (« worktree supprimé » si le dossier n'existe plus).
- **Titre d'une conversation**, par ordre de priorité : le titre donné à la session (`custom-title`, celui de l'appli Claude ou de `/rename`), le titre généré (`ai-title`), puis le premier message de l'utilisateur.
- **Nombre de messages** : messages texte de l'utilisateur, plus réponses de l'assistant (une réponse découpée sur plusieurs lignes compte pour une). Les sous-agents et résultats d'outils ne sont pas comptés.
- **Lignes corrompues ou incomplètes** : elles sont ignorées, et leur nombre est signalé sur la conversation concernée.
- **Rafraîchissement** : le dossier `.claude\projects` est surveillé, et la liste se met à jour seule environ 1,5 s après un changement. Le bouton ⟳ force une relecture.
- **État des conversations** : chaque conversation lancée dans l'app reçoit, par `--settings`, des hooks qui appellent `claude-manager.exe hook`. Cette commande écrit l'état dans le dossier `state\`, que l'app surveille. Les hooks que vous avez configurés continuent de fonctionner. Une conversation sans terminal ouvert est *terminée*.

### Actions

- **Clic sur une conversation**, ou **Reprendre** : ouvre la conversation dans un onglet de l'app (`claude --resume <id>` dans le terminal intégré). Si elle a été modifiée il y a moins de 2 minutes, l'app prévient qu'elle est peut-être ouverte dans Desktop ou dans un autre terminal.
- **Ouvrir dans un terminal externe** : Windows Terminal (sinon PowerShell), comme avant.
- **Nouvelle conversation** : démarre `claude --session-id <id>` dans l'app. Le bouton **+** d'une section crée la conversation dans cette section. L'option **Dans un nouveau worktree** (`claude -w`) est proposée pour un projet sous git.
- **Sections** : créer, renommer, colorer, replier, réordonner ; glisser une conversation dans une section ou vers « Sans section ». Supprimer une section ne supprime pas ses conversations.
- **Rechercher partout** (Ctrl+Maj+F) : cherche dans vos messages et dans les réponses de l'agent, sans les résultats d'outils, sans tenir compte des majuscules ni des accents.
- **Archiver** : déplace le `.jsonl` et son dossier compagnon (`<id>\` : sous-agents, résultats d'outils) vers le dossier d'archive. Un manifeste `<id>.archive.json` est écrit à côté, et la vue **Archives** permet de restaurer. La conversation garde sa section et sa couleur.
- **Supprimer** : envoie le fichier et son dossier dans la **Corbeille Windows**, après confirmation. Ils restent récupérables.
- Ces deux actions demandent une confirmation supplémentaire si la conversation a été modifiée il y a moins de 2 minutes (elle est peut-être encore ouverte).
- **Fermer un onglet ou l'app** ne demande confirmation que si un agent travaille ou qu'une action attend ta permission. Les conversations restent enregistrées.
- **Nouveau projet** : choisissez un dossier ; la fenêtre de sélection Windows permet aussi d'en créer un. Choisissez ensuite une catégorie.
- Les projets situés dans `AppData\Local\Temp` sont masqués par défaut (case à cocher en bas de la barre latérale).

## Développement

Prérequis : [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) (stable, MSVC), Visual Studio Build Tools (C++) et WebView2 (fourni avec Windows 11).

```powershell
npm install
```

Lancer l'application en mode développement (rechargement à chaud) :

```powershell
npm run tauri dev
```

Travailler uniquement l'interface dans un navigateur, avec des données fictives (aucune lecture de `.claude`) :

```powershell
npm run dev
```

Puis ouvrir http://localhost:1420.

Tests du backend Rust :

```powershell
cd src-tauri; cargo test
```

Lire vos vraies sessions et afficher un résumé (temps de lecture, titres) :

```powershell
cd src-tauri; cargo test --release real_scan -- --ignored --nocapture
```

## Générer le .exe

```powershell
npm run tauri build
```

Ce que produit la commande :

- l'exécutable : `src-tauri\target\release\claude-manager.exe`
- l'installateur : `src-tauri\target\release\bundle\nsis\Claude Manager_<version>_x64-setup.exe` (installation pour l'utilisateur courant, sans droits administrateur)
- sa signature `.sig`, utilisée par le module de mise à jour

La signature exige la clé privée dans l'environnement, sinon la compilation échoue :

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$HOME\.tauri\claude-manager.key"; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-Host "Mot de passe de la clé"
```

Installer un nouveau `setup.exe` par-dessus l'ancien met l'application à jour ; les données de `%APPDATA%\claude-manager` sont conservées.

## Mises à jour

Le bouton **Vérifier les mises à jour** (bas de la barre latérale) lit `latest.json` dans la dernière release GitHub publiée. Si une version plus récente existe, il demande avant de la télécharger. L'installateur téléchargé est vérifié avec la clé publique inscrite dans `tauri.conf.json`, puis installé : l'application se ferme et se relance.

### Mise en place (une seule fois)

1. Générer la paire de clés de signature et choisir un mot de passe :

   ```powershell
   npm run tauri signer generate -- -w "$HOME\.tauri\claude-manager.key"
   ```

   Gardez la clé privée (`claude-manager.key`) et son mot de passe en lieu sûr. **Si vous les perdez, les installations existantes ne pourront plus se mettre à jour.** Ne les commitez jamais.
2. Copier le contenu de `claude-manager.key.pub` dans `plugins.updater.pubkey` de `src-tauri/tauri.conf.json`.
3. Sur GitHub, dans *Settings > Secrets and variables > Actions*, créer les secrets `TAURI_SIGNING_PRIVATE_KEY` (contenu de `claude-manager.key`) et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

### Publier une version

1. Changer la version dans `src-tauri/Cargo.toml` : c'est la seule source, `tauri.conf.json` n'en a plus. Mettre `package.json` à la même valeur par cohérence.
2. Commiter, puis créer et pousser le tag correspondant :

   ```powershell
   git tag v0.2.0; git push origin v0.2.0
   ```

3. Le workflow `.github/workflows/release.yml` compile, signe et crée une release **en brouillon**. Son texte s'affiche dans la fenêtre « Mise à jour disponible » : relisez-le, puis publiez la release. Les utilisateurs la verront à leur prochaine vérification.

## Structure du code

```
src/                      Interface React + TypeScript
  App.tsx                 État global, actions, onglets, boîtes de dialogue
  api.ts                  Types et appels au backend
  pty.ts                  Terminal intégré : appels au backend et évènements
  activity.ts             État des conversations (pastilles, compteurs)
  sections.ts             Sections et couleurs des conversations
  util.ts                 Couleurs (contraste automatique), dates, noms
  devMock.ts              Faux backend pour `npm run dev` dans un navigateur (faux terminal compris)
  components/
    Sidebar.tsx           Catégories et projets, glisser-déposer (dnd-kit)
    ProjectView.tsx       Conversations d'un projet, sections, recherche
    TerminalTabs.tsx      Onglets des conversations ouvertes
    TerminalView.tsx      Terminal intégré (xterm.js)
    Activity.tsx          Pastille d'activité et compteurs
    GlobalSearch.tsx      Recherche dans toutes les conversations
    ArchivesView.tsx      Archives
    ColorPicker.tsx       Sélecteur de couleur
    UpdateButton.tsx      Vérification et installation des mises à jour
    Dialogs.tsx           Saisie de texte, nouveau projet
src-tauri/src/            Backend Rust
  sessions.rs             Lecture tolérante d'un .jsonl (titre, dates, nombre de messages)
  scanner.rs              Parcours de .claude\projects, cache, lecture parallèle
  worktrees.rs            Conversations de worktree rangées sous leur projet
  search.rs               Recherche dans le contenu
  pty.rs                  Terminal intégré (ConPTY) et arguments de `claude`
  activity.rs             Hooks de suivi d'état, sous-commande `claude-manager.exe hook`
  config.rs               config.json (écriture atomique, migrations)
  actions.rs              Terminal externe, archivage, restauration, Corbeille
  lib.rs                  Commandes Tauri et surveillance des dossiers
  main.rs                 Point d'entrée (et sous-commande `hook`)
```
