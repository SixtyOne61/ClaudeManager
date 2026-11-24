//! Claude Manager : backend Tauri.
//!
//! Commandes exposées à l'interface (voir `src/api.ts` côté front) :
//! lecture des projets/sessions, configuration, lancement de Claude, archives, Corbeille,
//! hand off, hubs.
//! Un observateur de fichiers émet l'évènement `sessions-changed` quand une conversation
//! apparaît, change ou disparaît.

mod activity;
mod actions;
mod attachments;
mod commands_list;
mod config;
mod context;
mod conversation;
mod handoff;
mod hubs;
mod limits;
mod messages;
mod project_settings;
mod pty;
mod run;
mod scanner;
mod search;
mod sessions;
mod shell_env;
mod suggestions;
mod worktrees;

use actions::{SessionFiles, Terminal};
use config::{AppPaths, ArchiveEntry, Config};
use notify::{RecursiveMode, Watcher};
use scanner::{ProjectInfo, Scanner};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

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

/// Pièce jointe d'un message pour la visionneuse ; une image disparue est cherchée dans le
/// `.jsonl` de la conversation (voir `attachments::preview`).
#[tauri::command(async)]
fn attachment_preview(state: State<AppState>, path: String, session_id: Option<String>, cwd: Option<String>) -> attachments::Preview {
    let transcript = session_id
        .filter(|id| actions::validate_session_id(id).is_ok())
        .and_then(|id| conversation::locate(state.scanner.root(), &id, cwd.as_deref()));
    attachments::preview(&path, transcript.as_deref())
}

/// Ouvre une pièce jointe avec l'application par défaut de Windows.
#[tauri::command]
fn open_attachment(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !Path::new(&path).is_file() {
        return Err("Fichier introuvable.".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// Commandes `/…` proposées dans la zone de saisie pour une conversation : intégrées,
/// skills et commandes personnels, du projet (`cwd` et ses parents) et des plugins activés,
/// complétés par les skills que Claude Code a annoncés dans le `.jsonl` de la conversation.
#[tauri::command(async)]
fn list_slash_commands(
    state: State<AppState>,
    listings: State<commands_list::ListingCache>,
    cwd: Option<String>,
    session_id: Option<String>,
) -> Vec<commands_list::SlashEntry> {
    let root = state.scanner.root();
    let claude_dir = root.parent().unwrap_or(root);
    let cwd_path = cwd.as_deref().filter(|c| !c.is_empty()).map(Path::new).filter(|p| p.is_dir());
    let disk = commands_list::discover(claude_dir, cwd_path);
    let listing = session_id
        .filter(|id| actions::validate_session_id(id).is_ok())
        .and_then(|id| conversation::locate(root, &id, cwd.as_deref()))
        .map(|path| listings.read(&path))
        .filter(|l| l.found);
    commands_list::merge(disk, listing.as_ref())
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

/// Enregistre la configuration envoyée par l'interface. La liste des archives, les liens des
/// hand off et les hubs sont gérés par le backend : ceux envoyés par l'interface sont ignorés. Les
/// suggestions sont recalculées (réglages, « Ignorer »).
#[tauri::command]
fn save_config(app: AppHandle, state: State<AppState>, mut cfg: Config) -> Result<Config, String> {
    {
        let mut current = state.config.lock().unwrap();
        cfg.archives = current.archives.clone();
        cfg.handoff_links = current.handoff_links.clone();
        cfg.hubs = current.hubs.clone();
        cfg.version = config::CONFIG_VERSION;
        state.save_config(&cfg)?;
        *current = cfg.clone();
    }
    emit_suggestions(&app);
    Ok(cfg)
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/// Contexte de chaque conversation et suggestions à afficher (voir suggestions.rs).
fn suggestions_snapshot(app: &AppHandle) -> suggestions::Snapshot {
    let contexts = app.state::<context::ContextStore>().all();
    let cfg = app.state::<AppState>().config.lock().unwrap().clone();
    suggestions::snapshot(&suggestions::Inputs { config: &cfg, contexts: &contexts })
}

/// Recalcule les suggestions et les émet vers l'interface ([`suggestions::EVT_SUGGESTIONS`]).
fn emit_suggestions(app: &AppHandle) {
    let _ = app.emit(suggestions::EVT_SUGGESTIONS, suggestions_snapshot(app));
}

/// Contexte de chaque conversation et suggestions actuelles (au chargement de l'interface).
#[tauri::command]
fn suggestions_list(app: AppHandle) -> suggestions::Snapshot {
    suggestions_snapshot(&app)
}

/// Enregistre un dossier comme projet (création depuis l'appli). Renvoie sa clé.
/// `language` : langue dans laquelle Claude répondra dans ce projet (rien = inchangée).
#[tauri::command]
fn add_project(state: State<AppState>, path: String, language: Option<String>) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_absolute() || !p.is_dir() {
        return Err(format!("Ce dossier n'existe pas : {path}"));
    }
    if let Some(lang) = language.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        project_settings::set_language(p, lang)?;
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
    archive_one(&state, &project_key, &session_id, force)?;
    let cfg = state.config.lock().unwrap().clone();
    Ok(cfg)
}

/// Archive une conversation et l'enregistre dans la configuration (voir [`archive_session`]).
fn archive_one(state: &AppState, project_key: &str, session_id: &str, force: bool) -> Result<(), String> {
    let (project_key, session_id) = (project_key.to_string(), session_id.to_string());
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
    state.save_config(&cfg)
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
    // Conversation d'un projet ou d'un hub archivé, restaurée seule : il revient avec elle.
    config::detach_from_archived_project(&mut cfg, &session_id, true);
    hubs::detach_from_archived_hub(&mut cfg, &session_id, true);
    state.save_config(&cfg)?;
    Ok(cfg.clone())
}

/// Marque un projet comme archivé, une fois ses conversations archivées par l'interface
/// (une à une, avec la confirmation habituelle pour celles modifiées il y a peu).
/// `session_ids` : les conversations archivées avec lui, restaurées avec lui.
#[tauri::command]
fn mark_project_archived(state: State<AppState>, project_key: String, session_ids: Vec<String>) -> Result<Config, String> {
    actions::validate_project_key(&project_key)?;
    let mut cfg = state.config.lock().unwrap();
    cfg.projects.entry(project_key).or_default().archived =
        Some(config::ProjectArchive { archived_at: actions::now_ms(), session_ids });
    state.save_config(&cfg)?;
    Ok(cfg.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreProjectResult {
    config: Config,
    restored: u32,
    /// Conversations restées dans les archives, avec la raison.
    errors: Vec<String>,
}

/// Restaure un projet archivé : remet en place les conversations archivées avec lui et le
/// fait revenir dans la barre latérale. Une conversation qui ne peut pas être restaurée
/// reste dans les archives (signalée dans `errors`), le projet revient quand même.
#[tauri::command(async)]
fn restore_project(state: State<AppState>, project_key: String) -> Result<RestoreProjectResult, String> {
    let mut cfg = state.config.lock().unwrap();
    let ids = cfg
        .projects
        .get(&project_key)
        .and_then(|p| p.archived.as_ref())
        .map(|a| a.session_ids.clone())
        .ok_or("Ce projet n'est pas archivé.")?;
    let (mut restored, mut errors) = (0, Vec::new());
    for id in ids {
        let Some(entry) = cfg.archives.iter().find(|a| a.session_id == id).cloned() else { continue };
        match actions::restore(&entry) {
            Ok(()) => {
                cfg.archives.retain(|a| a.session_id != id);
                restored += 1;
            }
            Err(e) => errors.push(format!("« {} » : {e}", entry.title)),
        }
    }
    if let Some(p) = cfg.projects.get_mut(&project_key) {
        p.archived = None;
    }
    state.save_config(&cfg)?;
    Ok(RestoreProjectResult { config: cfg.clone(), restored, errors })
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
    config::detach_from_archived_project(&mut cfg, &session_id, false);
    hubs::detach_from_archived_hub(&mut cfg, &session_id, false);
    state.save_config(&cfg)?;
    Ok(cfg.clone())
}

// ---------------------------------------------------------------------------
// Hand off (voir handoff.rs et src/handoff.ts)
// ---------------------------------------------------------------------------

/// Hand off, étape 2 : réponse de la parente à la consigne du résumé de passation, lue dans
/// son `.jsonl`, et premier message de la suite (avec les autres membres de son hub, le cas
/// échéant). `None` : réponse vide ou introuvable.
#[tauri::command(async)]
fn handoff_summary(
    state: State<AppState>,
    session_id: String,
    cwd: Option<String>,
    prompt: String,
    parent_title: String,
) -> Result<Option<handoff::Summary>, String> {
    actions::validate_session_id(&session_id)?;
    let Some(path) = conversation::locate(state.scanner.root(), &session_id, cwd.as_deref()) else { return Ok(None) };
    let cfg = state.config.lock().unwrap().clone();
    let hub = hubs::hub_of(&cfg, &session_id).and_then(|_| {
        let titles: HashMap<String, String> = state
            .scanner
            .scan()
            .into_iter()
            .flat_map(|p| p.sessions.into_iter().map(|s| (s.id, s.title)))
            .chain(cfg.archives.iter().map(|a| (a.session_id.clone(), a.title.clone())))
            .collect();
        let names = hubs::messaging_names(&claude_dir(&state).join("sessions"));
        hubs::handoff_context(&cfg, &session_id, |id| titles.get(id).cloned(), &names)
    });
    Ok(handoff::read_summary(&path, &prompt, &parent_title, hub.as_ref()))
}

/// Dossier de Claude Code (`~/.claude` ou `$CLAUDE_CONFIG_DIR`).
fn claude_dir(state: &AppState) -> &Path {
    let root = state.scanner.root();
    root.parent().unwrap_or(root)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HandoffFinish {
    config: Config,
    /// La parente n'a pas pu être archivée (la suite est créée et le lien enregistré).
    archive_error: Option<String>,
}

/// Hand off, dernière étape (la suite a reçu son premier message) : la suite prend la
/// section et la couleur de la parente, le lien parente → suite est enregistré, et la
/// parente est archivée. `project_key` : dossier de stockage de la parente.
#[tauri::command(async)]
fn handoff_finish(app: AppHandle, state: State<AppState>, project_key: String, parent_id: String, successor_id: String) -> Result<HandoffFinish, String> {
    actions::validate_session_id(&parent_id)?;
    actions::validate_session_id(&successor_id)?;
    // Le terminal de la parente vient d'être arrêté : son fichier peut rester verrouillé un
    // court instant. Elle vient d'écrire son résumé : pas de vérification « modifiée il y a peu ».
    let mut archive_error = None;
    for attempt in 0..5 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(300));
        }
        match archive_one(&state, &project_key, &parent_id, true) {
            Ok(()) => {
                archive_error = None;
                break;
            }
            Err(e) => archive_error = Some(e),
        }
    }
    let config = {
        let mut cfg = state.config.lock().unwrap();
        handoff::apply(&mut cfg, &parent_id, &successor_id, actions::now_ms());
        state.save_config(&cfg)?;
        cfg.clone()
    };
    emit_suggestions(&app);
    Ok(HandoffFinish { config, archive_error })
}

// ---------------------------------------------------------------------------
// Hubs (voir hubs.rs et src/hubs.ts)
// ---------------------------------------------------------------------------

/// Applique une modification des hubs, enregistre et renvoie la configuration.
fn change_hubs(state: &AppState, change: impl FnOnce(&mut Config) -> Result<(), String>) -> Result<Config, String> {
    let mut cfg = state.config.lock().unwrap();
    let mut next = cfg.clone();
    change(&mut next)?;
    state.save_config(&next)?;
    *cfg = next;
    Ok(cfg.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HubCreated {
    config: Config,
    hub_id: String,
}

/// Crée un hub vide (placé en dernier).
#[tauri::command]
fn hub_create(state: State<AppState>, name: String, color: Option<String>) -> Result<HubCreated, String> {
    let mut hub_id = String::new();
    let config = change_hubs(&state, |cfg| {
        hub_id = hubs::create(cfg, &name, color, actions::now_ms())?;
        Ok(())
    })?;
    Ok(HubCreated { config, hub_id })
}

/// Renomme un hub et change sa couleur (`color` : `None` = couleur par défaut).
#[tauri::command]
fn hub_update(state: State<AppState>, hub_id: String, name: String, color: Option<String>) -> Result<Config, String> {
    change_hubs(&state, |cfg| hubs::update(cfg, &hub_id, &name, color))
}

/// Supprime un hub : seulement le regroupement, ses conversations ne sont pas touchées.
#[tauri::command]
fn hub_delete(state: State<AppState>, hub_id: String) -> Result<Config, String> {
    change_hubs(&state, |cfg| hubs::delete(cfg, &hub_id))
}

/// Range une conversation dans un hub avec ce rôle (ou change son rôle) ; elle quitte son
/// ancien hub, et un nouveau coordinateur rétrograde l'ancien en exécutant.
#[tauri::command]
fn hub_set_member(state: State<AppState>, hub_id: String, conversation_id: String, role: config::HubRole) -> Result<Config, String> {
    actions::validate_session_id(&conversation_id)?;
    change_hubs(&state, |cfg| hubs::set_member(cfg, &hub_id, &conversation_id, role))
}

/// Retire une conversation d'un hub.
#[tauri::command]
fn hub_remove_member(state: State<AppState>, hub_id: String, conversation_id: String) -> Result<Config, String> {
    change_hubs(&state, |cfg| hubs::remove_member(cfg, &hub_id, &conversation_id))
}

/// Marque un hub comme archivé, une fois ses conversations archivées par l'interface (une à
/// une, avec la confirmation habituelle). `session_ids` : restaurées avec lui.
#[tauri::command]
fn hub_mark_archived(state: State<AppState>, hub_id: String, session_ids: Vec<String>) -> Result<Config, String> {
    change_hubs(&state, |cfg| hubs::mark_archived(cfg, &hub_id, session_ids, actions::now_ms()))
}

/// Restaure un hub archivé : remet en place les conversations archivées avec lui (celles qui ne
/// peuvent pas l'être restent dans les archives, signalées dans `errors`) et le fait revenir.
#[tauri::command(async)]
fn hub_restore(state: State<AppState>, hub_id: String) -> Result<RestoreProjectResult, String> {
    let mut cfg = state.config.lock().unwrap();
    let ids = hubs::archived_ids(&cfg, &hub_id)?;
    let (mut restored, mut errors) = (0, Vec::new());
    for id in ids {
        let Some(entry) = cfg.archives.iter().find(|a| a.session_id == id).cloned() else { continue };
        match actions::restore(&entry) {
            Ok(()) => {
                cfg.archives.retain(|a| a.session_id != id);
                // Archivée avec son projet : le projet revient avec elle.
                config::detach_from_archived_project(&mut cfg, &id, true);
                restored += 1;
            }
            Err(e) => errors.push(format!("« {} » : {e}", entry.title)),
        }
    }
    hubs::unarchive(&mut cfg, &hub_id)?;
    state.save_config(&cfg)?;
    Ok(RestoreProjectResult { config: cfg.clone(), restored, errors })
}

/// Fil des messages entre conversations d'un hub (voir messages.rs) : lu dans les `.jsonl` de
/// ses membres seulement (relus seulement s'ils ont changé). Hub inconnu ou format
/// inattendu : fil vide. Les noms appris en appariant envois et réceptions sont gardés.
#[tauri::command(async)]
fn hub_messages(state: State<AppState>, store: State<messages::MessageStore>, hub_id: String) -> Vec<messages::HubMessage> {
    let cfg = state.config.lock().unwrap().clone();
    let Some(hub) = hubs::find(&cfg, &hub_id) else { return Vec::new() };
    let members: Vec<(String, std::sync::Arc<Vec<messages::CrossMessage>>)> = hub
        .members
        .iter()
        .filter(|m| actions::validate_session_id(&m.conversation_id).is_ok())
        .filter_map(|m| {
            let archived = cfg.archives.iter().find(|a| a.session_id == m.conversation_id).map(|a| PathBuf::from(&a.archived_file));
            let path = archived.or_else(|| conversation::locate(state.scanner.root(), &m.conversation_id, None))?;
            Some((m.conversation_id.clone(), store.read(&path)))
        })
        .collect();
    let names = messaging_directory_inner(&state);
    let (thread, learned) = messages::hub_thread(&members, &names);
    state.scanner.remember_names(&learned);
    thread
}

/// Noms de messagerie connus (en cours, et déjà vus), pour relier un message à sa conversation
/// (voir `messages::resolve` et src/messages.ts).
#[tauri::command(async)]
fn messaging_directory(state: State<AppState>) -> Vec<messages::NameUse> {
    messaging_directory_inner(&state)
}

/// Nom de messagerie actuel d'une conversation, si elle tourne en ce moment (lu dans
/// `~/.claude/sessions/`, voir ADR 0002) : « + Exécutant » le donne à l'exécutant pour qu'il
/// rende compte à son coordinateur. `None` : elle ne tourne pas (ou format inattendu).
#[tauri::command(async)]
fn messaging_name(state: State<AppState>, session_id: String) -> Option<String> {
    hubs::messaging_names(&claude_dir(&state).join("sessions")).remove(&session_id)
}

fn messaging_directory_inner(state: &AppState) -> Vec<messages::NameUse> {
    state.scanner.remember_names(&messages::running_names(&claude_dir(state).join("sessions")))
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

/// Sous-commandes appelées par Claude Code, à traiter avant tout démarrage de Tauri :
/// - `hook` (hooks, voir activity.rs) : écrit l'état de la conversation ;
/// - `statusline` (ligne d'état, voir limits.rs) : écrit les limites d'utilisation et
///   affiche la ligne d'état.
///
/// Renvoie vrai si la ligne de commande était l'une d'elles.
pub fn run_subcommand() -> bool {
    match std::env::args().nth(1).as_deref() {
        Some(activity::HOOK_SUBCOMMAND) => activity::run_hook(),
        Some(limits::STATUSLINE_SUBCOMMAND) => limits::run_statusline(),
        _ => return false,
    }
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Avant tout autre thread : `PATH` du shell de l'utilisateur (voir shell_env.rs).
    #[cfg(target_os = "macos")]
    shell_env::import_login_path();
    let paths = AppPaths::detect();
    let _ = std::fs::create_dir_all(&paths.app_dir);
    let app_dir = paths.app_dir.clone();
    let state = AppState {
        scanner: Scanner::new(paths.claude_projects.clone(), paths.cache_file.clone()),
        config: Mutex::new(config::load(&paths.config_file)),
        terminal: actions::detect_terminal(),
        paths,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Liens des réponses de l'agent ouverts dans le navigateur (http/https uniquement).
        .plugin(tauri_plugin_opener::init())
        // Mises à jour : uniquement quand l'utilisateur clique sur « Vérifier les mises à jour ».
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        // Terminaux intégrés (voir pty.rs).
        .manage(pty::PtyManager::default())
        .manage(commands_list::ListingCache::default())
        // Messages entre conversations déjà lus, par fichier (voir messages.rs).
        .manage(messages::MessageStore::default())
        // Dernier remplissage du contexte de chaque conversation (voir context.rs).
        .manage(context::ContextStore::load(&app_dir))
        .on_window_event(pty::on_window_event)
        .setup(|app| {
            // Restes d'une fermeture brutale (plantage, arrêt forcé).
            attachments::clear();
            let root = app.state::<AppState>().paths.claude_projects.clone();
            start_watcher(app.handle().clone(), root);
            // États des conversations écrits par les hooks (voir activity.rs).
            let app_dir = app.state::<AppState>().paths.app_dir.clone();
            activity::start_watcher(app.handle().clone(), &app_dir);
            // Limites d'utilisation écrites par la ligne d'état (voir limits.rs).
            limits::start_watcher(app.handle().clone(), &app_dir);
            // Contexte de chaque conversation, écrit par la ligne d'état : les suggestions
            // sont recalculées à chaque changement (voir context.rs et suggestions.rs).
            context::start_watcher(app.handle().clone(), &app_dir, emit_suggestions);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan,
            search_sessions,
            search_all,
            conversation_read,
            list_slash_commands,
            get_config,
            save_config,
            add_project,
            launch_claude,
            open_folder,
            archive_session,
            restore_archive,
            mark_project_archived,
            restore_project,
            trash_session,
            trash_archive,
            check_open_elsewhere,
            handoff_summary,
            handoff_finish,
            hub_create,
            hub_update,
            hub_delete,
            hub_set_member,
            hub_remove_member,
            hub_mark_archived,
            hub_restore,
            hub_messages,
            messaging_directory,
            messaging_name,
            attachments::save_pasted_image,
            attachment_preview,
            open_attachment,
            pty::commands::pty_resume,
            pty::commands::pty_new_session,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
            pty::commands::pty_list,
            pty::commands::pty_quit,
            run::commands::run_integrated,
            run::commands::run_external,
            activity::activity_list,
            limits::usage_limits,
            suggestions_list,
            worktrees::commands::is_git_repo,
            worktrees::commands::worktree_offer,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Les images collées sont des fichiers temporaires : supprimées à la fermeture.
            if let tauri::RunEvent::Exit = event {
                attachments::clear();
            }
        });
}
