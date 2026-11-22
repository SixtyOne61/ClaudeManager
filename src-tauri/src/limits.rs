//! Limites d'utilisation du forfait (fenêtre de 5 heures et fenêtre hebdomadaire),
//! lues dans la ligne d'état (`statusLine`) de Claude Code.
//!
//! # Fonctionnement
//!
//! - Le fichier de réglages passé à `claude --settings` (voir activity.rs) déclare une
//!   ligne d'état : `claude-manager.exe statusline`. Claude Code lance cette commande
//!   après chaque réponse de l'assistant et lui passe sur l'entrée standard un JSON qui
//!   contient, pour les abonnements Pro, Max et Ultra, `rate_limits.five_hour` et
//!   `rate_limits.seven_day` (`used_percentage` de 0 à 100, `resets_at` en secondes Unix).
//!   Ces champs n'apparaissent qu'après la première réponse de l'API, et chaque fenêtre
//!   peut manquer (doc : <https://code.claude.com/docs/en/statusline>).
//! - La sous-commande ([`run_statusline`]) écrit `%APPDATA%\claude-manager\limits.json`
//!   ([`Limits`]) d'un coup, seulement si `rate_limits` est présent ; une fenêtre absente
//!   garde sa dernière valeur connue. Puis elle affiche une ligne d'état : celle de
//!   l'utilisateur s'il en a configuré une (sa commande est relancée avec la même entrée,
//!   2 s au plus), sinon une ligne courte « modèle · contexte ».
//! - Une ligne d'état ne connaît pas la forme « exec » des hooks : la commande passe par
//!   un shell (Git Bash, sinon PowerShell). Pour éviter tout souci de guillemets et
//!   d'espaces dans le chemin, la commande est le seul nom de l'exécutable, et l'app
//!   ajoute son dossier en tête du `PATH` de `claude` ([`path_with_exe_dir`]).
//! - L'app surveille le fichier ([`start_watcher`]) et émet [`EVT_LIMITS`].
//!
//! Les réglages de l'utilisateur sont seulement lus, jamais modifiés. Pas de réseau.

use crate::config::AppPaths;
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Sous-commande de l'exécutable appelée par la ligne d'état.
pub const STATUSLINE_SUBCOMMAND: &str = "statusline";
/// Évènement : les limites d'utilisation ont changé (charge utile : [`Limits`]).
pub const EVT_LIMITS: &str = "usage-limits";
const LIMITS_FILE: &str = "limits.json";
/// Délai maximal de la ligne d'état de l'utilisateur.
const USER_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
/// Champs de la ligne d'état de l'utilisateur recopiés dans la nôtre.
const COPIED_FIELDS: [&str; 3] = ["padding", "refreshInterval", "hideVimModeIndicator"];

/// Une fenêtre de limite.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    /// Part consommée, de 0 à 100.
    pub used_percentage: f64,
    /// Remise à zéro, en secondes depuis 1970.
    pub resets_at: i64,
}

/// Contenu de `limits.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
    /// Dernière mise à jour, en millisecondes depuis 1970.
    pub at: u64,
}

/// Fenêtres lues dans une entrée de ligne d'état.
#[derive(Debug, PartialEq, Default)]
pub struct Update {
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
}

fn window(v: &Value) -> Option<Window> {
    let used = v.get("used_percentage")?.as_f64().filter(|p| p.is_finite() && *p >= 0.0)?;
    let resets = v.get("resets_at")?.as_f64().filter(|t| t.is_finite() && *t > 0.0)?;
    Some(Window { used_percentage: used, resets_at: resets as i64 })
}

/// Lit `rate_limits` dans l'entrée JSON. `None` : absent, illisible, ou aucune fenêtre
/// utilisable (rien à écrire).
pub fn parse_update(input: &Value) -> Option<Update> {
    let rl = input.get("rate_limits")?;
    let u = Update { five_hour: rl.get("five_hour").and_then(window), seven_day: rl.get("seven_day").and_then(window) };
    (u.five_hour.is_some() || u.seven_day.is_some()).then_some(u)
}

/// Fusionne une mise à jour avec les valeurs précédentes : une fenêtre absente garde sa
/// dernière valeur (l'interface la montre remise à zéro une fois l'échéance passée).
pub fn merge(prev: Option<Limits>, u: Update, at: u64) -> Limits {
    let prev = prev.unwrap_or(Limits { five_hour: None, seven_day: None, at: 0 });
    Limits { five_hour: u.five_hour.or(prev.five_hour), seven_day: u.seven_day.or(prev.seven_day), at }
}

pub fn limits_file(app_dir: &Path) -> PathBuf {
    app_dir.join(LIMITS_FILE)
}

pub fn read_limits(file: &Path) -> Option<Limits> {
    serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()
}

/// Fusionne et écrit d'un coup (fichier temporaire puis renommage).
pub fn write_update(file: &Path, u: Update, at: u64) -> std::io::Result<Limits> {
    let limits = merge(read_limits(file), u, at);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::activity::write_atomic(file, &serde_json::to_vec(&limits).map_err(std::io::Error::other)?)?;
    Ok(limits)
}

// ---------------------------------------------------------------------------
// Ligne d'état affichée
// ---------------------------------------------------------------------------

/// Vrai si la commande est notre propre ligne d'état (pour ne jamais s'appeler soi-même).
fn is_ours(command: &str) -> bool {
    let c = command.to_ascii_lowercase();
    c.contains("claude-manager") && c.contains(STATUSLINE_SUBCOMMAND)
}

/// Commande de la ligne d'état de l'utilisateur, d'après ses réglages du plus prioritaire
/// au moins prioritaire (local du projet, projet, utilisateur). Le premier niveau qui
/// déclare `statusLine` décide : une commande (autre que la nôtre), ou rien.
pub fn user_status_command(levels: &[Option<Value>]) -> Option<String> {
    let sl = levels.iter().flatten().find_map(|v| v.get("statusLine"))?;
    if sl.get("type").and_then(Value::as_str) != Some("command") {
        return None;
    }
    let cmd = sl.get("command")?.as_str()?.trim();
    (!cmd.is_empty() && !is_ours(cmd)).then(|| cmd.to_string())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Dossier des réglages de Claude Code (`~/.claude` ou `$CLAUDE_CONFIG_DIR`).
fn claude_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"))
}

/// Réglages pouvant déclarer une ligne d'état, du plus prioritaire au moins prioritaire.
fn settings_levels(cwd: Option<&Path>) -> Vec<Option<Value>> {
    let mut levels = Vec::new();
    if let Some(cwd) = cwd {
        levels.push(read_json(&cwd.join(".claude").join("settings.local.json")));
        levels.push(read_json(&cwd.join(".claude").join("settings.json")));
    }
    levels.push(read_json(&claude_dir().join("settings.json")));
    levels
}

/// Ligne par défaut : « Opus · contexte 8 % ».
pub fn default_line(input: &Value) -> String {
    let model = input.pointer("/model/display_name").and_then(Value::as_str).filter(|m| !m.is_empty());
    let ctx = input.pointer("/context_window/used_percentage").and_then(Value::as_f64);
    match (model, ctx) {
        (Some(m), Some(p)) => format!("{m} · contexte {} %", p.round() as i64),
        (Some(m), None) => m.to_string(),
        (None, Some(p)) => format!("contexte {} %", p.round() as i64),
        (None, None) => String::new(),
    }
}

/// Git Bash, comme Claude Code : `CLAUDE_CODE_GIT_BASH_PATH`, sinon à côté de `git.exe`
/// du `PATH`, sinon l'emplacement d'installation habituel.
fn find_bash() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    let from_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path).find_map(|dir| {
            if !dir.join("git.exe").is_file() {
                return None;
            }
            // …\Git\cmd\git.exe ou …\Git\bin\git.exe → …\Git\bin\bash.exe
            dir.parent().map(|g| g.join("bin").join("bash.exe")).filter(|b| b.is_file())
        })
    });
    from_path.or_else(|| {
        ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"].iter().find_map(|var| {
            let base = PathBuf::from(std::env::var_os(var)?);
            [base.join("Git").join("bin").join("bash.exe"), base.join("Programs").join("Git").join("bin").join("bash.exe")]
                .into_iter()
                .find(|b| b.is_file())
        })
    })
}

/// Lance la commande de l'utilisateur dans un shell, lui passe `input`, et renvoie sa
/// sortie standard. `None` : échec, ou plus de [`USER_COMMAND_TIMEOUT`].
fn run_user_command(command: &str, input: &str, cwd: Option<&Path>) -> Option<String> {
    let mut cmd = match find_bash() {
        Some(bash) => {
            let mut c = Command::new(bash);
            c.arg("-c").arg(command);
            c
        }
        None => {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
            c
        }
    };
    if let Some(cwd) = cwd.filter(|d| d.is_dir()) {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    stop_std_handles_inheritance();
    let mut child = cmd.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let data = input.to_string();
    std::thread::spawn(move || {
        let _ = stdin.write_all(data.as_bytes());
    });
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = tx.send(out);
    });
    let deadline = Instant::now() + USER_COMMAND_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let out = rx.recv_timeout(Duration::from_millis(300)).ok()?;
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Rend nos entrée et sorties standard non héritables. Sinon, un processus lancé par la
/// commande de l'utilisateur et qui lui survit (arrêtée après le délai, par exemple)
/// garderait ouverte notre sortie standard, et Claude Code attendrait sa fin.
fn stop_std_handles_inheritance() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};
        use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
        for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            // SAFETY : appels Win32 sur nos propres poignées standard ; un échec est sans effet.
            unsafe {
                let h = GetStdHandle(id);
                if !h.is_null() && h as isize != -1 {
                    SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
                }
            }
        }
    }
}

/// Sous-commande `statusline` : enregistre les limites puis affiche la ligne d'état.
/// Ne fait jamais échouer Claude Code : toute erreur est ignorée (l'appelant sort avec 0).
pub fn run_statusline() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    // Un éventuel BOM (entrée passée par PowerShell) rendrait le JSON illisible.
    let parsed: Option<Value> = serde_json::from_str(input.trim_start_matches('\u{feff}')).ok();
    if let Some(u) = parsed.as_ref().and_then(parse_update) {
        let _ = write_update(&limits_file(&AppPaths::detect().app_dir), u, crate::activity::now_ms());
    }
    let cwd = parsed
        .as_ref()
        .and_then(|v| v.get("cwd").or_else(|| v.pointer("/workspace/current_dir")))
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let line = match user_status_command(&settings_levels(cwd.as_deref())) {
        Some(command) => run_user_command(&command, &input, cwd.as_deref()).unwrap_or_default(),
        None => parsed.as_ref().map(default_line).unwrap_or_default(),
    };
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes());
    if !line.ends_with('\n') && !line.is_empty() {
        let _ = out.write_all(b"\n");
    }
    let _ = out.flush();
}

// ---------------------------------------------------------------------------
// Réglages et lancement
// ---------------------------------------------------------------------------

/// Bloc `statusLine` du fichier de réglages : notre commande, par son seul nom de fichier
/// (le dossier est ajouté au `PATH`), plus `padding`, `refreshInterval` et
/// `hideVimModeIndicator` repris de la ligne d'état de l'utilisateur. `None` si le nom de
/// l'exécutable demanderait des guillemets.
pub fn statusline_settings(exe: &Path, user_settings: Option<&Value>) -> Option<Value> {
    let name = exe.file_name()?.to_str()?;
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return None;
    }
    let mut sl = json!({ "type": "command", "command": format!("{name} {STATUSLINE_SUBCOMMAND}") });
    if let Some(user) = user_settings.and_then(|s| s.get("statusLine")).and_then(Value::as_object) {
        for k in COPIED_FIELDS {
            if let Some(v) = user.get(k) {
                sl[k] = v.clone();
            }
        }
    }
    Some(sl)
}

/// Réglages de l'utilisateur (lecture seule), pour [`statusline_settings`].
pub fn user_settings() -> Option<Value> {
    read_json(&claude_dir().join("settings.json"))
}

/// `PATH` à donner à `claude` : dossier de l'exécutable de l'app en tête, pour que la
/// ligne d'état le trouve par son nom quel que soit le shell.
pub fn path_with_exe_dir(exe: &Path, current: Option<OsString>) -> Option<OsString> {
    let dir = PathBuf::from(crate::activity::exe_for_hook(exe.parent()?));
    let mut dirs = vec![dir];
    if let Some(cur) = current {
        dirs.extend(std::env::split_paths(&cur));
    }
    std::env::join_paths(dirs).ok()
}

// ---------------------------------------------------------------------------
// Côté app
// ---------------------------------------------------------------------------

/// Observe `limits.json` et émet [`EVT_LIMITS`] à chaque changement.
pub fn start_watcher(app: AppHandle, app_dir: &Path) {
    let file = limits_file(app_dir);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if event.paths.iter().any(|p| p.file_name().is_some_and(|n| n == LIMITS_FILE)) {
            let _ = tx.send(());
        }
    });
    let Ok(mut watcher) = watcher else { return };
    if watcher.watch(app_dir, RecursiveMode::NonRecursive).is_err() {
        return;
    }
    std::thread::spawn(move || {
        let _watcher = watcher;
        while rx.recv().is_ok() {
            // Regroupe les évènements d'une même écriture.
            while rx.recv_timeout(Duration::from_millis(100)).is_ok() {}
            if let Some(l) = read_limits(&file) {
                let _ = app.emit(EVT_LIMITS, l);
            }
        }
    });
}

/// Dernières limites connues (`None` : aucune encore).
#[tauri::command]
pub fn usage_limits() -> Option<Limits> {
    read_limits(&limits_file(&AppPaths::detect().app_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn parses_rate_limits() {
        let full = v(r#"{"model":{"display_name":"Opus"},"rate_limits":{
            "five_hour":{"used_percentage":23.5,"resets_at":1738425600},
            "seven_day":{"used_percentage":41.2,"resets_at":1738857600},
            "spend_limit":{"used_percentage":62.8,"resets_at":1740787200}}}"#);
        assert_eq!(
            parse_update(&full),
            Some(Update {
                five_hour: Some(Window { used_percentage: 23.5, resets_at: 1738425600 }),
                seven_day: Some(Window { used_percentage: 41.2, resets_at: 1738857600 }),
            })
        );
        // Une seule fenêtre.
        let only_week = v(r#"{"rate_limits":{"seven_day":{"used_percentage":5,"resets_at":1738857600}}}"#);
        assert_eq!(parse_update(&only_week), Some(Update { five_hour: None, seven_day: Some(Window { used_percentage: 5.0, resets_at: 1738857600 }) }));
        // Absent, vide, ou inutilisable : rien à écrire.
        assert_eq!(parse_update(&v(r#"{"model":{"display_name":"Opus"}}"#)), None);
        assert_eq!(parse_update(&v(r#"{"rate_limits":{}}"#)), None);
        assert_eq!(parse_update(&v(r#"{"rate_limits":null}"#)), None);
        assert_eq!(parse_update(&v(r#"{"rate_limits":{"five_hour":{"used_percentage":"x","resets_at":1}}}"#)), None);
        assert_eq!(parse_update(&v(r#"{"rate_limits":{"five_hour":{"used_percentage":10}}}"#)), None);
        assert_eq!(parse_update(&v(r#"{"rate_limits":{"five_hour":{"used_percentage":-1,"resets_at":1}}}"#)), None);
        assert_eq!(parse_update(&v(r#"[1,2]"#)), None);
    }

    #[test]
    fn writes_and_merges_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let file = limits_file(dir.path());
        let w = |p: f64, t: i64| Some(Window { used_percentage: p, resets_at: t });
        let l = write_update(&file, Update { five_hour: w(10.0, 100), seven_day: w(20.0, 200) }, 1).unwrap();
        assert_eq!(l, Limits { five_hour: w(10.0, 100), seven_day: w(20.0, 200), at: 1 });
        // Fenêtre absente : la dernière valeur est gardée.
        write_update(&file, Update { five_hour: w(42.0, 150), seven_day: None }, 2).unwrap();
        assert_eq!(read_limits(&file), Some(Limits { five_hour: w(42.0, 150), seven_day: w(20.0, 200), at: 2 }));
        write_update(&file, Update { five_hour: None, seven_day: w(25.0, 300) }, 3).unwrap();
        assert_eq!(read_limits(&file), Some(Limits { five_hour: w(42.0, 150), seven_day: w(25.0, 300), at: 3 }));
        // Format du fichier, sans fichier temporaire restant.
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(json, json!({"fiveHour":{"usedPercentage":42.0,"resetsAt":150},"sevenDay":{"usedPercentage":25.0,"resetsAt":300},"at":3}));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        // Fichier précédent illisible : remplacé.
        std::fs::write(&file, "pas du json").unwrap();
        let l = write_update(&file, Update { five_hour: None, seven_day: w(1.0, 9) }, 4).unwrap();
        assert_eq!(l, Limits { five_hour: None, seven_day: w(1.0, 9), at: 4 });
    }

    #[test]
    fn decides_user_statusline() {
        let cmd = |c: &str| Some(json!({ "statusLine": { "type": "command", "command": c } }));
        // Utilisateur seulement.
        assert_eq!(user_status_command(&[None, None, cmd("~/.claude/statusline.sh")]), Some("~/.claude/statusline.sh".into()));
        // Le projet l'emporte sur l'utilisateur ; le local sur le projet.
        assert_eq!(user_status_command(&[None, cmd("proj"), cmd("user")]), Some("proj".into()));
        assert_eq!(user_status_command(&[cmd("local"), cmd("proj"), cmd("user")]), Some("local".into()));
        // Niveaux sans statusLine ignorés.
        assert_eq!(user_status_command(&[Some(json!({"model":"opus"})), None, cmd("user")]), Some("user".into()));
        // Aucune, vide, autre type, ou notre propre commande : ligne par défaut.
        assert_eq!(user_status_command(&[None, None, None]), None);
        assert_eq!(user_status_command(&[None, None, cmd("  ")]), None);
        assert_eq!(user_status_command(&[Some(json!({"statusLine":{"type":"other","command":"x"}})), cmd("user")]), None);
        assert_eq!(user_status_command(&[None, None, cmd("claude-manager.exe statusline")]), None);
    }

    #[test]
    fn default_status_line() {
        assert_eq!(default_line(&v(r#"{"model":{"display_name":"Opus"},"context_window":{"used_percentage":8.4}}"#)), "Opus · contexte 8 %");
        assert_eq!(default_line(&v(r#"{"model":{"display_name":"Opus"},"context_window":{"used_percentage":null}}"#)), "Opus");
        assert_eq!(default_line(&v(r#"{}"#)), "");
    }

    #[test]
    fn statusline_settings_block() {
        let exe = Path::new(r"C:\Program Files\Claude Manager\claude-manager.exe");
        assert_eq!(statusline_settings(exe, None), Some(json!({"type":"command","command":"claude-manager.exe statusline"})));
        let user = json!({"statusLine":{"type":"command","command":"x","padding":2,"refreshInterval":5,"other":1}});
        assert_eq!(
            statusline_settings(exe, Some(&user)),
            Some(json!({"type":"command","command":"claude-manager.exe statusline","padding":2,"refreshInterval":5}))
        );
        // Nom qui demanderait des guillemets : pas de ligne d'état.
        assert_eq!(statusline_settings(Path::new(r"C:\a\claude manager.exe"), None), None);
    }

    #[test]
    fn path_gets_exe_dir_first() {
        let exe = Path::new(r"\\?\C:\Program Files\Claude Manager\claude-manager.exe");
        let p = path_with_exe_dir(exe, Some(OsString::from(r"C:\Windows;C:\Tools"))).unwrap();
        assert_eq!(p, OsString::from(r"C:\Program Files\Claude Manager;C:\Windows;C:\Tools"));
    }
}
