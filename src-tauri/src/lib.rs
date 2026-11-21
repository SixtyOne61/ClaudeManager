//! Claude Manager : backend Tauri.
//!
//! Commandes exposées à l'interface (voir `src/api.ts` côté front) :
//! lecture des projets/sessions, configuration, lancement de Claude, archives, Corbeille.
//! Un observateur de fichiers émet l'évènement `sessions-changed` quand une conversation
//! apparaît, change ou disparaît.

mod activity;
mod actions;
mod config;
mod conversation;
mod pty;
mod scanner;
mod search;
mod sessions;
mod worktrees;

use actions::{SessionFiles, Terminal};
use config::{AppPaths, ArchiveEntry, Config};
use notify::{RecursiveMode, Watcher};
use scanner::{ProjectInfo, Scanner};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

/// État partagé entre les commandes.
struct AppState {
    paths: AppPaths,
    scanner: Scanner,
    config: Mutex<Config>,
    terminal: Terminal,
}

impl AppState {
    fn save_config(&self, cfg: &Config) -> Result<(), String> {
        config::save(&self.paths.config_file, cfg).map_err(|e| format!("Enregistrement de la configuration impossible : {e}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    projects: Vec<ProjectInfo>,
    terminal: &'static str,
    claude_root: String,
    app_dir: String,
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/// Liste tous les projets et leurs conversations.
/// Les projets connus de la configuration mais sans conversation (créés depuis l'appli,
/// ou dont toutes les conversations sont archivées) sont ajoutés avec une liste vide.
#[tauri::command(async)]
fn scan(state: State<AppState>, ptys: State<pty::PtyManager>) -> ScanResult {
    let mut projects = state.scanner.scan();
    // Une nouvelle conversation lancée dans le terminal intégré n'a pas encore de fichier :
    // sa place dans une section est gardée tant que son terminal est ouvert.
    let open: Vec<String> = ptys.list().into_iter().map(|p| p.key).collect();
    prune_config(&state, &projects, &open);
    let cfg = {
        let mut cfg = state.config.lock().unwrap();
        // Anciennes entrées qui rangeaient un worktree comme un projet : nettoyées en silence.
        if worktrees::clean_config(&mut cfg, &HashSet::new()) {
            let _ = state.save_config(&cfg);
        }
        cfg.clone()
    };
    let found: HashSet<String> = projects.iter().map(|p| p.key.clone()).collect();

    let mut known: Vec<String> = cfg.categories.iter().flat_map(|c| c.project_keys.clone()).collect();
    known.extend(cfg.projects.iter().filter(|(_, p)| p.path.is_some()).map(|(k, _)| k.clone()));
    let mut added = HashSet::new();
    for key in known {
        if found.contains(&key) || !added.insert(key.clone()) {
            continue;
        }
        let path = cfg.projects.get(&key).and_then(|p| p.path.clone());
        projects.push(Scanner::make_project(key, path, Vec::new()));
    }

    // Pour les projets créés depuis l'appli, le chemin choisi fait foi.
    for p in projects.iter_mut().filter(|p| p.path.is_none()) {
        if let Some(path) = cfg.projects.get(&p.key).and_then(|x| x.path.clone()) {
            *p = Scanner::make_project(p.key.clone(), Some(path), std::mem::take(&mut p.sessions));
        }
    }

    ScanResult {
        projects,
        terminal: state.terminal.label(),
        claude_root: state.scanner.root().to_string_lossy().to_string(),
        app_dir: state.paths.app_dir.to_string_lossy().to_string(),
    }
}

/// Retire des sections et des préférences par conversation les conversations qui
/// n'existent plus (ni sur le disque, ni dans les archives). Sans effet si le dossier
/// des projets de Claude est introuvable : un scan vide ne doit rien effacer.
/// `open` : conversations ouvertes dans le terminal intégré, conservées même sans fichier.
fn prune_config(state: &AppState, projects: &[ProjectInfo], open: &[String]) {
    if !state.scanner.root().is_dir() {
        return;
    }
    let mut existing: HashSet<String> = projects.iter().flat_map(|p| p.sessions.iter().map(|s| s.id.clone())).collect();
    existing.extend(open.iter().cloned());
    let mut cfg = state.config.lock().unwrap();
    if config::prune_conversations(&mut cfg, &existing) {
        let _ = state.save_config(&cfg);
    }
}

/// Recherche plein texte dans les conversations d'un projet. Renvoie les ids trouvés.
/// Mêmes règles que la recherche globale (voir `search.rs`).
#[tauri::command(async)]
fn search_sessions(state: State<AppState>, project_key: String, query: String) -> Result<Vec<String>, String> {
    actions::validate_project_key(&project_key)?;
    let Some(q) = search::Query::new(&query) else {
        return Ok(Vec::new());
    };
    // Le projet et ses worktrees (dont les conversations sont rangées dans d'autres dossiers).
    let files: Vec<PathBuf> = worktrees::storage_keys(state.scanner.root(), &project_key)
        .iter()
        .flat_map(|k| std::fs::read_dir(state.scanner.root().join(k)).into_iter().flatten().flatten())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    // Un thread par fichier (limité par le nombre de fichiers du projet, généralement faible).
    let hits = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for chunk in files.chunks(files.len().div_ceil(8).max(1)) {
            let (hits, q) = (&hits, &q);
            s.spawn(move || {
                for f in chunk {
                    if search::file_matches(f, q) {
                        if let Some(stem) = f.file_stem() {
                            hits.lock().unwrap().push(stem.to_string_lossy().to_string());
                        }
                    }
                }
            });
        }
    });
    Ok(hits.into_inner().unwrap())
}

/// Lit la conversation affichée (interface de conversation) à partir de `offset` (octets)
/// et `line` (numéro de la ligne qui y commence) : seule la suite du fichier est relue à
/// chaque changement. Fichier pas encore créé : morceau vide avec `exists: false`.
#[tauri::command(async)]
fn conversation_read(state: State<AppState>, session_id: String, cwd: Option<String>, offset: u64, line: u32) -> Result<conversation::Chunk, String> {
    actions::validate_session_id(&session_id)?;
    Ok(match conversation::locate(state.scanner.root(), &session_id, cwd.as_deref()) {
        Some(path) => conversation::read_chunk(&path, offset, line),
        None => conversation::Chunk::default(),
    })
}

/// Recherche dans le contenu de toutes les conversations, archives comprises.
/// Une nouvelle recherche interrompt la précédente.
#[tauri::command(async)]
fn search_all(state: State<AppState>, query: String) -> search::SearchResult {
    let projects = state.scanner.scan();
    let archives = state.config.lock().unwrap().archives.clone();
    let targets = search::targets(state.scanner.root(), &projects, &archives);
    search::search(&targets, &query)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config(state: State<AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

/// Enregistre la configuration envoyée par l'interface. La liste des archives est gérée
/// par le backend : celle envoyée par l'interface est ignorée.
#[tauri::command]
fn save_config(state: State<AppState>, mut cfg: Config) -> Result<Config, String> {
    let mut current = state.config.lock().unwrap();
    cfg.archives = current.archives.clone();
    cfg.version = config::CONFIG_VERSION;
    state.save_config(&cfg)?;
    *current = cfg.clone();
    Ok(cfg)
}

/// Enregistre un dossier comme projet (création depuis l'appli). Renvoie sa clé.
#[tauri::command]
fn add_project(state: State<AppState>, path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_absolute() || !p.is_dir() {
        return Err(format!("Ce dossier n'existe pas : {path}"));
    }
    let key = sessions::encode_project_path(&path);
    let mut cfg = state.config.lock().unwrap();
    cfg.projects.entry(key.clone()).or_default().path = Some(path);
    state.save_config(&cfg)?;
    Ok(key)
}

// ---------------------------------------------------------------------------
// Lancement
// ---------------------------------------------------------------------------

/// Ouvre un terminal dans `path` avec `claude`, ou `claude --resume <sessionId>`.
#[tauri::command]
fn launch_claude(state: State<AppState>, path: String, session_id: Option<String>) -> Result<(), String> {
    actions::launch_claude(state.terminal, &path, session_id.as_deref())
}

/// Avant d'ouvrir une conversation dans le terminal intégré : erreur préfixée
/// `SESSION_ACTIVE` si son fichier a été modifié il y a moins de 2 minutes par un autre
/// programme (Claude Desktop, un autre terminal). `released_at` : moment (ms) où l'app a
/// fermé son propre terminal pour cette conversation, ses écritures ne comptent pas.
#[tauri::command(async)]
fn check_open_elsewhere(state: State<AppState>, project_key: String, session_id: String, released_at: Option<u64>) -> Result<(), String> {
    let files = SessionFiles::locate(state.scanner.root(), &project_key, &session_id)?;
    files.check_not_open_elsewhere(released_at)
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    actions::open_folder(&path)
}

// ---------------------------------------------------------------------------
// Archives et Corbeille
// ---------------------------------------------------------------------------

/// Archive une conversation. Sans `force`, refuse une session modifiée il y a peu
/// (erreur préfixée `SESSION_ACTIVE`, que l'interface propose de forcer).
#[tauri::command(async)]
fn archive_session(state: State<AppState>, project_key: String, session_id: String, force: bool) -> Result<Config, String> {
    let files = SessionFiles::locate(state.scanner.root(), &project_key, &session_id)?;
    if !force {
        files.check_not_active()?;
    }
    let info = sessions::read_session(&files.file, &project_key);
    let project_path = info.as_ref().and_then(|i| i.cwd.clone());
    let entry = ArchiveEntry {
        session_id: session_id.clone(),
        project_key: project_key.clone(),
        project_path: project_path.clone(),
        title: info.as_ref().map(|i| i.title.clone()).unwrap_or_else(|| session_id.clone()),
        message_count: info.as_ref().map(|i| i.message_count).unwrap_or(0),
        updated_at: info.as_ref().and_then(|i| i.updated_at.clone()),
        ..Default::default()
    };
    let entry = actions::archive(&files, &state.paths.archive_dir, entry)?;
    state.scanner.forget(&files.file);

    let mut cfg = state.config.lock().unwrap();
    // Mémorise le chemin du projet : il reste affiché même sans conversation restante.
    // Pour une conversation de worktree, c'est le projet parent qui est mémorisé.
    let (prefs_key, prefs_path) = match project_path.as_deref().and_then(worktrees::detect) {
        Some((parent, _)) => (worktrees::parent_key(&parent, cfg.projects.keys()), Some(parent)),
        None => (project_key, project_path),
    };
    let prefs = cfg.projects.entry(prefs_key).or_default();
    if prefs.path.is_none() {
        prefs.path = prefs_path;
    }
    cfg.archives.retain(|a| a.session_id != session_id);
    cfg.archives.push(entry);
    state.save_config(&cfg)?;
    Ok(cfg.clone())
}

#[tauri::command(async)]
fn restore_archive(state: State<AppState>, session_id: String) -> Result<Config, String> {
    let mut cfg = state.config.lock().unwrap();
    let entry = cfg
        .archives
        .iter()
        .find(|a| a.session_id == session_id)
        .cloned()
        .ok_or("Archive introuvable dans la configuration.")?;
    actions::restore(&entry)?;
    cfg.archives.retain(|a| a.session_id != session_id);
    state.save_config(&cfg)?;
    Ok(cfg.clone())
}

/// Envoie une conversation (fichier + dossier compagnon) dans la Corbeille Windows.
#[tauri::command(async)]
fn trash_session(state: State<AppState>, project_key: String, session_id: String, force: bool) -> Result<(), String> {
    let files = SessionFiles::locate(state.scanner.root(), &project_key, &session_id)?;
    if !force {
        files.check_not_active()?;
    }
    let mut paths = vec![files.file.clone()];
    paths.extend(files.dir.clone());
    actions::to_trash(&paths)?;
    state.scanner.forget(&files.file);
    Ok(())
}

/// Envoie une conversation archivée dans la Corbeille et la retire de la liste des archives.
#[tauri::command(async)]
fn trash_archive(state: State<AppState>, session_id: String) -> Result<Config, String> {
    let mut cfg = state.config.lock().unwrap();
    if let Some(entry) = cfg.archives.iter().find(|a| a.session_id == session_id).cloned() {
        actions::trash_archive(&entry)?;
    }
    cfg.archives.retain(|a| a.session_id != session_id);
    state.save_config(&cfg)?;
    Ok(cfg.clone())
}

// ---------------------------------------------------------------------------
// Détection automatique des changements
// ---------------------------------------------------------------------------

/// Observe `~/.claude/projects` et émet `sessions-changed` (au plus une fois toutes
/// les ~1,5 s) quand un `.jsonl` ou un titre de session change. Émet aussi
/// `conversation-changed` (identifiant de la conversation) dès qu'un `.jsonl` change, au
/// plus toutes les ~250 ms, pour l'interface de conversation affichée en direct.
fn start_watcher(app: tauri::AppHandle, root: PathBuf) {
    let (tx, rx) = mpsc::channel::<()>();
    let (tx_conv, rx_conv) = mpsc::channel::<String>();
    let root_for_filter = root.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let mut relevant = false;
        for p in &event.paths {
            let depth = p.strip_prefix(&root_for_filter).map(|r| r.components().count()).unwrap_or(0);
            let is_jsonl = p.extension().is_some_and(|x| x == "jsonl");
            let is_title = p.file_name().is_some_and(|n| n == "custom-title.json");
            // projet/session.jsonl (2), nouveau dossier projet (1), projet/session/custom-title.json (3)
            relevant |= (is_jsonl && depth == 2) || depth == 1 || (is_title && depth == 3);
            if is_jsonl && depth == 2 {
                if let Some(stem) = p.file_stem() {
                    let _ = tx_conv.send(stem.to_string_lossy().to_string());
                }
            }
        }
        if relevant {
            let _ = tx.send(());
        }
    });
    let Ok(mut watcher) = watcher else { return };
    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        return;
    }
    let app_conv = app.clone();
    std::thread::spawn(move || {
        // Le watcher vit aussi longtemps que ce thread.
        let _watcher = watcher;
        while rx.recv().is_ok() {
            // Regroupe les rafales d'évènements (une session active écrit en continu).
            while rx.recv_timeout(Duration::from_millis(1500)).is_ok() {}
            let _ = app.emit("sessions-changed", ());
        }
    });
    std::thread::spawn(move || {
        while let Ok(first) = rx_conv.recv() {
            // Regroupe les évènements reçus pendant 250 ms : une émission par conversation.
            let mut ids = HashSet::from([first]);
            let until = Instant::now() + Duration::from_millis(250);
            while let Some(left) = until.checked_duration_since(Instant::now()) {
                match rx_conv.recv_timeout(left) {
                    Ok(id) => {
                        ids.insert(id);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            for id in ids {
                let _ = app_conv.emit("conversation-changed", id);
            }
        }
    });
}

/// Sous-commande `hook` (appelée par les hooks de Claude Code, voir activity.rs) :
/// écrit l'état de la conversation puis rend la main. À appeler avant tout démarrage
/// de Tauri ; renvoie vrai si la ligne de commande était bien cette sous-commande.
pub fn run_subcommand() -> bool {
    if std::env::args().nth(1).as_deref() != Some(activity::HOOK_SUBCOMMAND) {
        return false;
    }
    activity::run_hook();
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let paths = AppPaths::detect();
    let _ = std::fs::create_dir_all(&paths.app_dir);
    let state = AppState {
        scanner: Scanner::new(paths.claude_projects.clone(), paths.cache_file.clone()),
        config: Mutex::new(config::load(&paths.config_file)),
        terminal: actions::detect_terminal(),
        paths,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Mises à jour : uniquement quand l'utilisateur clique sur « Vérifier les mises à jour ».
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        // Terminaux intégrés (voir pty.rs).
        .manage(pty::PtyManager::default())
        .on_window_event(pty::on_window_event)
        .setup(|app| {
            let root = app.state::<AppState>().paths.claude_projects.clone();
            start_watcher(app.handle().clone(), root);
            // États des conversations écrits par les hooks (voir activity.rs).
            let app_dir = app.state::<AppState>().paths.app_dir.clone();
            activity::start_watcher(app.handle().clone(), &app_dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan,
            search_sessions,
            search_all,
            conversation_read,
            get_config,
            save_config,
            add_project,
            launch_claude,
            open_folder,
            archive_session,
            restore_archive,
            trash_session,
            trash_archive,
            check_open_elsewhere,
            pty::commands::pty_resume,
            pty::commands::pty_new_session,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
            pty::commands::pty_list,
            pty::commands::pty_quit,
            activity::activity_list,
            worktrees::commands::is_git_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
