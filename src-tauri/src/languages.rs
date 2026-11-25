//! Langues de l'interface (voir src/i18n/translate.ts) : traductions enregistrées et appel à
//! `claude -p` pour les produire.
//!
//! - Une langue traduite est un fichier `%APPDATA%\claude-manager\languages\<code>.json`,
//!   écrit et lu tel quel par l'interface (`{ code, name, entries: { clé: { text, hash } } }`).
//!   Le code (BCP 47) est vérifié : il sert de nom de fichier.
//! - [`commands::claude_ask`] lance `claude -p` avec l'abonnement de l'utilisateur : sans
//!   outils, sans serveur MCP ni commande `/…`, sans enregistrer de session (rien n'apparaît
//!   dans la liste des conversations), depuis un dossier temporaire (pas de CLAUDE.md lu).
//!   Le texte est envoyé sur l'entrée standard ; la réponse est le champ `result` de la
//!   sortie JSON. Un appel en cours s'arrête avec [`commands::claude_cancel`].

use crate::ui_error::ui_err;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

/// Dossier des langues et appels `claude -p` en cours (par identifiant d'appel).
pub struct LanguageStore {
    dir: PathBuf,
    jobs: Arc<Mutex<HashMap<String, Child>>>,
}

impl LanguageStore {
    pub fn new(app_dir: &Path) -> Self {
        Self { dir: app_dir.join("languages"), jobs: Arc::default() }
    }

    fn file(&self, code: &str) -> Result<PathBuf, String> {
        if !valid_code(code) {
            return Err(ui_err("languages.invalidCode", json!({ "code": code })));
        }
        Ok(self.dir.join(format!("{code}.json")))
    }
}

/// Code de langue BCP 47 simple (`en`, `pt-BR`, `zh-Hant`) : lettres, chiffres et tirets.
pub fn valid_code(code: &str) -> bool {
    let mut parts = code.split('-');
    let first = parts.next().unwrap_or_default();
    (2..=3).contains(&first.len())
        && first.chars().all(|c| c.is_ascii_alphabetic())
        && parts.all(|p| (2..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// Langue traduite disponible.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LanguageInfo {
    pub code: String,
    /// Nom dans la langue elle-même (« English »).
    pub name: String,
}

/// Langues enregistrées, par nom.
pub fn list(dir: &Path) -> Vec<LanguageInfo> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<LanguageInfo> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let code = p.file_stem()?.to_str()?.to_string();
            if p.extension()? != "json" || !valid_code(&code) {
                return None;
            }
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).ok()?).ok()?;
            let name = v.get("name").and_then(Value::as_str).unwrap_or(&code).to_string();
            Some(LanguageInfo { code, name })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Réponse de `claude -p --output-format json` : le texte du champ `result`, ou une erreur.
pub fn parse_claude_output(out: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(out.trim()).map_err(|_| ui_err("languages.badResponse", json!({ "detail": excerpt(out) })))?;
    let result = v.get("result").and_then(Value::as_str).unwrap_or_default().to_string();
    if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
        return Err(ui_err("languages.claudeFailed", json!({ "detail": excerpt(&result) })));
    }
    Ok(result)
}

fn excerpt(s: &str) -> String {
    let s = s.trim();
    match s.char_indices().nth(300) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

pub mod commands {
    use super::*;
    use tauri::State;

    #[tauri::command]
    pub fn languages_list(store: State<'_, LanguageStore>) -> Vec<LanguageInfo> {
        list(&store.dir)
    }

    /// Contenu d'une langue enregistrée (`null` si absente ou illisible).
    #[tauri::command]
    pub fn language_read(store: State<'_, LanguageStore>, code: String) -> Result<Option<Value>, String> {
        let file = store.file(&code)?;
        Ok(std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()))
    }

    #[tauri::command]
    pub fn language_write(store: State<'_, LanguageStore>, code: String, data: Value) -> Result<(), String> {
        let file = store.file(&code)?;
        let save = || -> std::io::Result<()> {
            std::fs::create_dir_all(&store.dir)?;
            let tmp = file.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(&data)?)?;
            std::fs::rename(&tmp, &file)
        };
        save().map_err(|e| ui_err("languages.saveFailed", json!({ "detail": e.to_string() })))
    }

    #[tauri::command]
    pub fn language_delete(store: State<'_, LanguageStore>, code: String) -> Result<(), String> {
        let file = store.file(&code)?;
        match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(ui_err("languages.deleteFailed", json!({ "detail": e.to_string() }))),
            _ => Ok(()),
        }
    }

    /// `claude -p` : envoie `prompt` (consigne système `system`) au modèle `model` et renvoie
    /// sa réponse. `job` : identifiant choisi par l'interface, pour [`claude_cancel`].
    #[tauri::command]
    pub async fn claude_ask(store: State<'_, LanguageStore>, job: String, model: String, system: String, prompt: String) -> Result<String, String> {
        let jobs = store.jobs.clone();
        tauri::async_runtime::spawn_blocking(move || run_claude(&jobs, &job, &model, &system, &prompt))
            .await
            .map_err(|e| ui_err("languages.claudeFailed", json!({ "detail": e.to_string() })))?
    }

    /// Arrête un appel `claude -p` en cours (sans effet s'il est déjà fini).
    #[tauri::command]
    pub fn claude_cancel(store: State<'_, LanguageStore>, job: String) {
        if let Some(mut child) = store.jobs.lock().unwrap().remove(&job) {
            let _ = child.kill();
        }
    }
}

fn run_claude(jobs: &Mutex<HashMap<String, Child>>, job: &str, model: &str, system: &str, prompt: &str) -> Result<String, String> {
    let claude = crate::pty::find_claude().ok_or_else(|| ui_err("pty.claudeMissing", json!({ "platform": if cfg!(windows) { "windows" } else { "other" } })))?;
    let args: Vec<String> = [
        "-p",
        "--model",
        model,
        "--output-format",
        "json",
        "--no-session-persistence",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let cwd = std::env::temp_dir().join("claude-manager-translate");
    let _ = std::fs::create_dir_all(&cwd);
    // Consigne système dans un fichier : passée en argument, ses guillemets et retours à la
    // ligne seraient abîmés par `cmd.exe` (installation npm de Claude Code).
    let system_file = cwd.join(format!("system-{}.txt", job.chars().filter(char::is_ascii_alphanumeric).collect::<String>()));
    std::fs::write(&system_file, system).map_err(|e| ui_err("languages.claudeFailed", json!({ "detail": e.to_string() })))?;
    let mut args = args;
    args.push("--system-prompt-file".into());
    args.push(system_file.to_string_lossy().to_string());
    let argv = crate::pty::build_argv(&claude, &args);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| ui_err("languages.claudeFailed", json!({ "detail": e.to_string() })))?;
    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    jobs.lock().unwrap().insert(job.to_string(), child);

    let data = prompt.to_string();
    let writer = std::thread::spawn(move || {
        if let Some(mut s) = stdin.take() {
            let _ = s.write_all(data.as_bytes());
        }
    });
    let err_reader = std::thread::spawn(move || {
        let mut e = String::new();
        if let Some(mut s) = stderr.take() {
            let _ = s.read_to_string(&mut e);
        }
        e
    });
    let mut out = String::new();
    if let Some(mut s) = stdout.take() {
        let _ = s.read_to_string(&mut out);
    }
    let _ = writer.join();
    let err = err_reader.join().unwrap_or_default();
    let _ = std::fs::remove_file(&system_file);

    // Retiré de la liste : absent, c'est qu'il a été annulé.
    let Some(mut child) = jobs.lock().unwrap().remove(job) else {
        return Err(ui_err("languages.cancelled", json!({})));
    };
    let _ = child.wait();
    if out.trim().is_empty() {
        return Err(ui_err("languages.claudeFailed", json!({ "detail": excerpt(&err) })));
    }
    parse_claude_output(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_codes() {
        for ok in ["en", "fr", "pt-BR", "zh-Hant", "es-419", "ast"] {
            assert!(valid_code(ok), "{ok}");
        }
        for bad in ["", "e", "english", "../x", "en_US", "en-", "en-a", "fr/x", "c:"] {
            assert!(!valid_code(bad), "{bad}");
        }
    }

    #[test]
    fn lists_saved_languages_by_name() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("en.json"), r#"{"code":"en","name":"English","entries":{}}"#).unwrap();
        std::fs::write(d.path().join("de.json"), r#"{"code":"de","name":"Deutsch","entries":{}}"#).unwrap();
        std::fs::write(d.path().join("bad name.json"), "{}").unwrap();
        std::fs::write(d.path().join("it.json"), "pas du json").unwrap();
        let l = list(d.path());
        assert_eq!(l.iter().map(|x| x.code.as_str()).collect::<Vec<_>>(), ["de", "en"]);
    }

    #[test]
    fn reads_claude_result() {
        assert_eq!(parse_claude_output(r#"{"type":"result","is_error":false,"result":"{\"ok\":true}"}"#).unwrap(), r#"{"ok":true}"#);
        assert!(parse_claude_output(r#"{"is_error":true,"result":"Not logged in"}"#).unwrap_err().contains("languages.claudeFailed"));
        assert!(parse_claude_output("oops").unwrap_err().contains("languages.badResponse"));
    }
}
