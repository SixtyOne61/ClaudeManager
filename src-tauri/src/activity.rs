//! État des conversations (en cours, attend ta réponse, terminée), suivi par des hooks
//! de Claude Code.
//!
//! # Fonctionnement
//!
//! - Chaque lancement de `claude` dans le terminal intégré reçoit `--settings <fichier>`
//!   ([`settings_args`]) : un fichier de réglages généré par l'app dans
//!   `%APPDATA%\claude-manager\hooks-settings.json`, qui ajoute des hooks à cette
//!   conversation seulement. Claude Code additionne les hooks de tous les niveaux de
//!   réglages : ceux de l'utilisateur continuent de fonctionner, et ses fichiers ne sont
//!   jamais modifiés.
//! - Les hooks lancent l'exécutable de l'app lui-même : `claude-manager.exe hook`
//!   (forme « exec » : pas de shell, donc aucun souci de guillemets ni d'espaces dans le
//!   chemin). [`run_hook`] lit le JSON du hook sur l'entrée standard et écrit
//!   `%APPDATA%\claude-manager\state\<session_id>.json` ([`Activity`]), puis se termine
//!   toujours avec succès.
//! - L'app surveille ce dossier ([`start_watcher`]) et émet [`EVT_ACTIVITY`] vers
//!   l'interface. Une conversation dont le terminal intégré ne tourne pas est *terminée*,
//!   quoi que dise son fichier : l'évènement porte alors `activity: null`.
//!
//! Pas de réseau, pas de port local.

use crate::config::AppPaths;
use crate::pty::PtyManager;
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// Sous-commande de l'exécutable appelée par les hooks.
pub const HOOK_SUBCOMMAND: &str = "hook";
/// Évènement : l'état d'une conversation a changé ([`ActivityEvent`]).
pub const EVT_ACTIVITY: &str = "conversation-activity";
/// Nom du fichier de réglages passé à `claude --settings`.
const SETTINGS_FILE: &str = "hooks-settings.json";
/// Délai maximal d'un hook, en secondes (il dure normalement quelques millisecondes).
const HOOK_TIMEOUT_S: u32 = 10;

/// État affiché d'une conversation.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// L'agent travaille.
    Running,
    /// L'agent attend l'utilisateur (permission, question, fin de tour).
    Waiting,
    /// La session Claude Code s'est terminée.
    Ended,
}

/// Raison précise de l'état (utile au ticket « Interface de conversation » pour savoir
/// quand faire remonter le terminal).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Un message vient d'être envoyé.
    Prompt,
    /// Un outil va s'exécuter ou vient de s'exécuter.
    Tool,
    /// Demande de permission (outil, plan…).
    Permission,
    /// Question posée à l'utilisateur (AskUserQuestion, formulaire MCP…).
    Question,
    /// Fin de tour : l'agent attend le prochain message.
    Turn,
    /// Tour interrompu par une erreur d'API.
    Error,
    /// Conversation qui vient de démarrer (ou d'être reprise).
    Start,
    /// Fin de la session.
    End,
}

/// Contenu d'un fichier `state\<session_id>.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub session_id: String,
    pub state: State,
    pub kind: Kind,
    /// Évènement de hook d'origine (`PreToolUse`, `Notification`…), ou `Launch` quand
    /// l'app vient de lancer `claude`.
    pub event: String,
    /// Précision : type de notification, nom de l'outil, type d'erreur ou raison de fin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Horodatage, en millisecondes depuis 1970.
    pub at: u64,
}

/// Évènement envoyé à l'interface. `activity: None` : conversation terminée.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub session_id: String,
    pub activity: Option<Activity>,
}

/// Champs utiles de l'entrée d'un hook (le reste est ignoré).
#[derive(Deserialize, Default)]
struct HookInput {
    session_id: Option<String>,
    hook_event_name: Option<String>,
    notification_type: Option<String>,
    tool_name: Option<String>,
    error: Option<String>,
    reason: Option<String>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Traduit l'entrée JSON d'un hook en état. `None` : évènement sans effet sur l'état
/// (ou entrée illisible).
pub fn activity_from_hook(input: &str, at: u64) -> Option<Activity> {
    let h: HookInput = serde_json::from_str(input).ok()?;
    let session_id = h.session_id.filter(|id| crate::actions::validate_session_id(id).is_ok())?;
    let event = h.hook_event_name?;
    let (state, kind, detail) = match event.as_str() {
        "SessionStart" => (State::Waiting, Kind::Start, None),
        "UserPromptSubmit" => (State::Running, Kind::Prompt, None),
        // Après une permission accordée, PostToolUse remet la conversation « en cours ».
        "PreToolUse" | "PostToolUse" => (State::Running, Kind::Tool, h.tool_name),
        "PermissionRequest" => {
            let kind = if h.tool_name.as_deref() == Some("AskUserQuestion") { Kind::Question } else { Kind::Permission };
            (State::Waiting, kind, h.tool_name)
        }
        "Notification" => {
            let kind = match h.notification_type.as_deref()? {
                "permission_prompt" => Kind::Permission,
                "elicitation_dialog" | "elicitation_url_dialog" | "agent_needs_input" => Kind::Question,
                "idle_prompt" => Kind::Turn,
                _ => return None,
            };
            (State::Waiting, kind, h.notification_type)
        }
        "Stop" => (State::Waiting, Kind::Turn, None),
        "StopFailure" => (State::Waiting, Kind::Error, h.error),
        "SessionEnd" => (State::Ended, Kind::End, h.reason),
        _ => return None,
    };
    Some(Activity { session_id, state, kind, event, detail, at })
}

/// Types de notification suivis (filtre des hooks `Notification`, pour ne pas lancer
/// l'exécutable pour rien).
const NOTIFICATION_MATCHER: &str = "permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input";

/// Réglages passés à `claude --settings` : un hook par évènement suivi, qui lance
/// `<exe> hook` en forme « exec » (`args` présent : pas de shell, chaque argument est
/// transmis tel quel, le chemin n'a pas besoin de guillemets même avec des espaces).
pub fn settings_json(exe: &Path) -> serde_json::Value {
    let handler = json!({
        "type": "command",
        "command": exe_for_hook(exe),
        "args": [HOOK_SUBCOMMAND],
        "timeout": HOOK_TIMEOUT_S,
    });
    let group = |matcher: Option<&str>| match matcher {
        Some(m) => json!([{ "matcher": m, "hooks": [handler.clone()] }]),
        None => json!([{ "hooks": [handler.clone()] }]),
    };
    json!({
        "hooks": {
            "SessionStart": group(None),
            "UserPromptSubmit": group(None),
            "PreToolUse": group(Some("*")),
            "PostToolUse": group(Some("*")),
            "PermissionRequest": group(Some("*")),
            "Notification": group(Some(NOTIFICATION_MATCHER)),
            "Stop": group(None),
            "StopFailure": group(None),
            "SessionEnd": group(None),
        }
    })
}

/// Chemin de l'exécutable tel qu'écrit dans le hook : sans le préfixe `\\?\` que
/// `current_exe` peut renvoyer (mal compris par certains lanceurs).
pub fn exe_for_hook(exe: &Path) -> String {
    let s = exe.to_string_lossy();
    match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
    }
}

pub fn state_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("state")
}

/// Écrit un fichier d'un coup (fichier temporaire puis renommage) : l'app ne lit jamais
/// un fichier à moitié écrit.
fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

pub fn write_activity(dir: &Path, a: &Activity) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let data = serde_json::to_vec(a).map_err(std::io::Error::other)?;
    write_atomic(&dir.join(format!("{}.json", a.session_id)), &data)
}

pub fn read_activity(dir: &Path, session_id: &str) -> Option<Activity> {
    crate::actions::validate_session_id(session_id).ok()?;
    let text = std::fs::read_to_string(dir.join(format!("{session_id}.json"))).ok()?;
    serde_json::from_str(&text).ok()
}

/// Sous-commande `hook` : lit l'entrée du hook et écrit l'état. Ne doit jamais bloquer
/// ni faire échouer Claude Code : toute erreur est ignorée (l'appelant sort avec 0).
pub fn run_hook() {
    let mut input = String::new();
    // Tout lire, même si seuls quelques champs servent : Claude Code écrit l'entrée en entier.
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    if let Some(a) = activity_from_hook(&input, now_ms()) {
        let _ = write_activity(&state_dir(&AppPaths::detect().app_dir), &a);
    }
}

/// Prépare un lancement de `claude` dans le terminal intégré : écrit le fichier de
/// réglages et renvoie les arguments à ajouter (`--settings <fichier>`). En cas d'échec,
/// rien n'est ajouté : la conversation se lance, sans suivi d'état.
pub fn settings_args() -> Vec<String> {
    let app_dir = AppPaths::detect().app_dir;
    let file = app_dir.join(SETTINGS_FILE);
    let written = std::env::current_exe().ok().and_then(|exe| {
        let text = serde_json::to_vec_pretty(&settings_json(&exe)).ok()?;
        std::fs::create_dir_all(&app_dir).ok()?;
        write_atomic(&file, &text).ok()
    });
    match written {
        Some(()) => vec!["--settings".into(), file.to_string_lossy().to_string()],
        None => Vec::new(),
    }
}

/// Appelé juste après le lancement de `claude` : état initial « attend ta réponse »
/// (question de confiance du dossier, ou attente du premier message), qui remplace un
/// éventuel état périmé d'un lancement précédent. Le hook `SessionStart` suivra.
pub fn on_launched(session_id: &str) {
    let a = Activity { session_id: session_id.into(), state: State::Waiting, kind: Kind::Start, event: "Launch".into(), detail: None, at: now_ms() };
    let _ = write_activity(&state_dir(&AppPaths::detect().app_dir), &a);
}

/// État effectif : `None` (terminée) si le terminal intégré ne tourne pas ou si la
/// session s'est terminée.
fn effective(app: &AppHandle, dir: &Path, session_id: &str) -> Option<Activity> {
    if !app.state::<PtyManager>().is_running(session_id) {
        return None;
    }
    read_activity(dir, session_id).filter(|a| a.state != State::Ended)
}

pub fn emit(app: &AppHandle, session_id: &str, activity: Option<Activity>) {
    let _ = app.emit(EVT_ACTIVITY, ActivityEvent { session_id: session_id.into(), activity });
}

/// Observe le dossier des états et émet [`EVT_ACTIVITY`] à chaque changement, sans délai.
pub fn start_watcher(app: AppHandle, app_dir: &Path) {
    let dir = state_dir(app_dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        for p in &event.paths {
            if p.extension().is_some_and(|x| x == "json") {
                if let Some(stem) = p.file_stem() {
                    let _ = tx.send(stem.to_string_lossy().to_string());
                }
            }
        }
    });
    let Ok(mut watcher) = watcher else { return };
    if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
        return;
    }
    std::thread::spawn(move || {
        let _watcher = watcher;
        while let Ok(id) = rx.recv() {
            if crate::actions::validate_session_id(&id).is_err() || !app.state::<PtyManager>().is_running(&id) {
                continue;
            }
            let a = effective(&app, &dir, &id);
            emit(&app, &id, a);
        }
    });
}

/// États effectifs de toutes les conversations dont le terminal intégré tourne.
#[tauri::command]
pub fn activity_list(app: AppHandle) -> Vec<Activity> {
    let dir = state_dir(&AppPaths::detect().app_dir);
    let keys: Vec<String> = app.state::<PtyManager>().list().into_iter().filter(|p| p.running).map(|p| p.key).collect();
    keys.iter().filter_map(|k| effective(&app, &dir, k)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "28cde7fb-e61a-4bd9-a66f-10ba27d395a5";

    fn hook(event: &str, extra: &str) -> Option<Activity> {
        let input = format!(r#"{{"session_id":"{ID}","transcript_path":"C:\\x.jsonl","cwd":"C:\\p","hook_event_name":"{event}"{extra}}}"#);
        activity_from_hook(&input, 42)
    }

    fn sk(a: Option<Activity>) -> Option<(State, Kind, Option<String>)> {
        a.map(|a| (a.state, a.kind, a.detail))
    }

    #[test]
    fn parses_hook_payloads() {
        use Kind::*;
        use State::*;
        assert_eq!(sk(hook("SessionStart", r#","source":"resume""#)), Some((Waiting, Start, None)));
        assert_eq!(sk(hook("UserPromptSubmit", r#","prompt":"salut""#)), Some((Running, Prompt, None)));
        let pre = r#","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"t1""#;
        assert_eq!(sk(hook("PreToolUse", pre)), Some((Running, Tool, Some("Bash".into()))));
        assert_eq!(sk(hook("PostToolUse", pre)), Some((Running, Tool, Some("Bash".into()))));
        assert_eq!(sk(hook("PermissionRequest", r#","tool_name":"Edit""#)), Some((Waiting, Permission, Some("Edit".into()))));
        assert_eq!(sk(hook("PermissionRequest", r#","tool_name":"AskUserQuestion""#)), Some((Waiting, Question, Some("AskUserQuestion".into()))));
        let notif = |t: &str| hook("Notification", &format!(r#","message":"m","notification_type":"{t}""#));
        assert_eq!(sk(notif("permission_prompt")), Some((Waiting, Permission, Some("permission_prompt".into()))));
        assert_eq!(sk(notif("elicitation_dialog")), Some((Waiting, Question, Some("elicitation_dialog".into()))));
        assert_eq!(sk(notif("idle_prompt")), Some((Waiting, Turn, Some("idle_prompt".into()))));
        assert_eq!(notif("auth_success"), None);
        assert_eq!(hook("Notification", ""), None);
        assert_eq!(sk(hook("Stop", r#","stop_hook_active":false"#)), Some((Waiting, Turn, None)));
        assert_eq!(sk(hook("StopFailure", r#","error":"rate_limit""#)), Some((Waiting, Error, Some("rate_limit".into()))));
        assert_eq!(sk(hook("SessionEnd", r#","reason":"prompt_input_exit""#)), Some((Ended, End, Some("prompt_input_exit".into()))));
        assert_eq!(hook("SubagentStart", ""), None);

        let a = hook("Stop", "").unwrap();
        assert_eq!((a.session_id.as_str(), a.event.as_str(), a.at), (ID, "Stop", 42));
        // Entrées invalides : ignorées.
        assert_eq!(activity_from_hook("pas du json", 1), None);
        assert_eq!(activity_from_hook(r#"{"hook_event_name":"Stop"}"#, 1), None);
        assert_eq!(activity_from_hook(r#"{"session_id":"..\\..\\x","hook_event_name":"Stop"}"#, 1), None);
    }

    #[test]
    fn state_file_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let a = hook("PermissionRequest", r#","tool_name":"Bash""#).unwrap();
        write_activity(dir.path(), &a).unwrap();
        let text = std::fs::read_to_string(dir.path().join(format!("{ID}.json"))).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v, json!({"sessionId": ID, "state": "waiting", "kind": "permission", "event": "PermissionRequest", "detail": "Bash", "at": 42}));
        assert_eq!(read_activity(dir.path(), ID), Some(a));
        // Réécriture : remplace le fichier, sans laisser de fichier temporaire.
        let b = hook("Stop", "").unwrap();
        write_activity(dir.path(), &b).unwrap();
        assert_eq!(read_activity(dir.path(), ID), Some(b));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        assert_eq!(read_activity(dir.path(), "../x"), None);
    }

    #[test]
    fn generates_settings() {
        let exe = Path::new(r"C:\Program Files\Claude Manager\claude-manager.exe");
        let v = settings_json(exe);
        let hooks = v["hooks"].as_object().unwrap();
        for ev in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd"] {
            let h = &hooks[ev][0]["hooks"][0];
            assert_eq!(h["type"], "command", "{ev}");
            // Forme exec : chemin brut (espaces compris, sans guillemets), argument à part.
            assert_eq!(h["command"], r"C:\Program Files\Claude Manager\claude-manager.exe", "{ev}");
            assert_eq!(h["args"], json!(["hook"]), "{ev}");
            assert_eq!(h["timeout"], 10);
        }
        assert_eq!(hooks.len(), 9);
        assert_eq!(hooks["PreToolUse"][0]["matcher"], "*");
        assert!(hooks["Stop"][0].get("matcher").is_none());
        assert_eq!(hooks["Notification"][0]["matcher"], NOTIFICATION_MATCHER);
        // Le JSON produit, relu, garde le chemin intact (échappement des barres obliques inverses).
        let text = serde_json::to_string(&v).unwrap();
        assert!(text.contains(r#""command":"C:\\Program Files\\Claude Manager\\claude-manager.exe""#));
    }

    #[test]
    fn exe_path_for_hook() {
        assert_eq!(exe_for_hook(Path::new(r"\\?\C:\a b\claude-manager.exe")), r"C:\a b\claude-manager.exe");
        assert_eq!(exe_for_hook(Path::new(r"\\?\UNC\srv\share\cm.exe")), r"\\srv\share\cm.exe");
        assert_eq!(exe_for_hook(Path::new(r"C:\dev\target\debug\claude-manager.exe")), r"C:\dev\target\debug\claude-manager.exe");
    }
}
