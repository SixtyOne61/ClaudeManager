# Claude Manager

Petite application de bureau Windows pour organiser ses projets et conversations **Claude Code** :
catégories colorées, glisser-déposer, reprise d'une conversation en un clic, archives et Corbeille.

Tout est local. La seule connexion réseau est la vérification des mises à jour, et elle n'a lieu que si vous cliquez sur **Vérifier les mises à jour** (voir plus bas). La fenêtre elle-même n'a aucun accès réseau (sa politique de sécurité l'interdit).

## Fonctionnement

| Quoi | Où |
| --- | --- |
| Projets et conversations (source de vérité, **lecture seule**) | `%USERPROFILE%\.claude\projects\<chemin-encodé>\<session-id>.jsonl` (ou `%CLAUDE_CONFIG_DIR%\projects`) |
| Catégories, couleurs, noms d'affichage, liste des archives | `%APPDATA%\claude-manager\config.json` |
| Cache des résumés de conversations (supprimable sans risque) | `%APPDATA%\claude-manager\cache.json` |
| Conversations archivées | `%APPDATA%\claude-manager\archive\<projet>\` |

- **Chemin du projet** : le nom du dossier dans `.claude\projects` est le chemin avec chaque caractère non alphanumérique remplacé par `-`, ce qui est irréversible. Le vrai chemin est lu dans le champ `cwd` des messages.
- **Titre d'une conversation**, par ordre de priorité : le titre donné à la session (`custom-title`, celui de l'appli Claude ou de `/rename`), le titre généré (`ai-title`), puis le premier message de l'utilisateur.
- **Nombre de messages** : messages texte de l'utilisateur, plus réponses de l'assistant (une réponse découpée sur plusieurs lignes compte pour une). Les sous-agents et résultats d'outils ne sont pas comptés.
- **Lignes corrompues ou incomplètes** : elles sont ignorées, et leur nombre est signalé sur la conversation concernée.
- **Rafraîchissement** : le dossier `.claude\projects` est surveillé, et la liste se met à jour seule environ 1,5 s après un changement. Le bouton ⟳ force une relecture.

### Actions

- **Reprendre** (ou double-clic) : ouvre Windows Terminal (sinon PowerShell) dans le dossier du projet et lance `claude --resume <id>`.
- **Nouvelle conversation** : lance `claude` dans le dossier du projet.
- **Archiver** : déplace le `.jsonl` et son dossier compagnon (`<id>\` : sous-agents, résultats d'outils) vers le dossier d'archive. Un manifeste `<id>.archive.json` est écrit à côté, et la vue **Archives** permet de restaurer.
- **Supprimer** : envoie le fichier et son dossier dans la **Corbeille Windows**, après confirmation. Ils restent récupérables.
- Ces deux actions demandent une confirmation supplémentaire si la conversation a été modifiée il y a moins de 2 minutes (elle est peut-être encore ouverte).
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
  App.tsx                 État global, actions, boîtes de dialogue
  api.ts                  Types et appels au backend
  util.ts                 Couleurs (contraste automatique), dates, noms
  devMock.ts              Faux backend pour `npm run dev` dans un navigateur
  components/
    Sidebar.tsx           Catégories et projets, glisser-déposer (dnd-kit)
    ProjectView.tsx       Conversations d'un projet, recherche
    ArchivesView.tsx      Archives
    ColorPicker.tsx       Sélecteur de couleur
    UpdateButton.tsx      Vérification et installation des mises à jour
    Dialogs.tsx           Saisie de texte, nouveau projet
src-tauri/src/            Backend Rust
  sessions.rs             Lecture tolérante d'un .jsonl (titre, dates, nombre de messages)
  scanner.rs              Parcours de .claude\projects, cache, lecture parallèle
  config.rs               config.json (écriture atomique)
  actions.rs              Terminal, archivage, restauration, Corbeille
  lib.rs                  Commandes Tauri et surveillance du dossier
```
