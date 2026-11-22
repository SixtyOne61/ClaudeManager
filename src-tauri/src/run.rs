//! Commandes proposées par l'agent (blocs de code `bash`, `powershell`, `cmd`… d'une réponse),
//! exécutées à la demande de l'utilisateur (bouton ▶ de la conversation) dans le dossier de
//! la conversation :
//!
//! - [`commands::run_integrated`] : dans un pseudo-terminal de l'app ([`PtyManager`], clé
//!   `run-<id>`), affiché sous le bloc ; le processus se termine avec le script ;
//! - [`commands::run_external`] : dans une nouvelle fenêtre (Windows Terminal, sinon une
//!   console), qui reste ouverte après le script.
//!
//! Le texte du bloc est écrit tel quel dans un fichier de script temporaire (`.ps1`, `.cmd`,
//! `.sh`), exécuté par le shell correspondant : pas de guillemets à échapper, et un bloc de
//! plusieurs lignes s'exécute comme on l'aurait tapé ligne par ligne.

use crate::pty::{normalize_dir, LaunchSpec, Program, PtyInfo, PtyManager};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// Taille maximale d'un script (un bloc de code d'une réponse).
const MAX_SCRIPT: usize = 256 * 1024;
/// Les scripts temporaires plus vieux que ce délai sont supprimés au lancement suivant.
const SCRIPT_TTL: Duration = Duration::from_secs(24 * 3600);

/// Shell qui exécute un bloc, d'après sa langue Markdown.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Shell {
    PowerShell,
    Cmd,
    Bash,
}

impl Shell {
    /// Langue du bloc (`bash`, `ps1`, `bat`…) → shell, ou `None` si ce n'est pas une commande.
    pub fn from_lang(lang: &str) -> Option<Shell> {
        match lang.trim().to_ascii_lowercase().as_str() {
            "powershell" | "pwsh" | "ps" | "ps1" => Some(Shell::PowerShell),
            "cmd" | "bat" | "batch" | "dos" => Some(Shell::Cmd),
            "bash" | "sh" | "shell" | "zsh" | "console" | "shell-session" | "shellsession" => Some(Shell::Bash),
            _ => None,
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Shell::PowerShell => "ps1",
            Shell::Cmd => "cmd",
            Shell::Bash => "sh",
        }
    }
}

/// Texte à exécuter : pour une transcription de console (`$ commande` suivi de sa sortie),
/// seules les lignes de commande sont gardées, sans le `$ `.
pub fn script_body(lang: &str, code: &str) -> String {
    let transcript = matches!(lang.trim().to_ascii_lowercase().as_str(), "console" | "shell-session" | "shellsession");
    if transcript {
        let cmds: Vec<&str> = code.lines().filter_map(|l| l.strip_prefix("$ ")).collect();
        if !cmds.is_empty() {
            return cmds.join("\n");
        }
    }
    code.to_string()
}

/// Contenu du fichier de script. `keep_open` : fenêtre externe, le shell reste ouvert ensuite
/// (pour Bash, un shell interactif prend la suite dans le même dossier).
pub fn script_file_content(shell: Shell, body: &str, keep_open: bool) -> Vec<u8> {
    let body = body.replace("\r\n", "\n");
    match shell {
        // PowerShell 5.1 lit un script sans BOM dans la page de code ANSI.
        Shell::PowerShell => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend(body.replace('\n', "\r\n").into_bytes());
            v
        }
        // cmd lit le script dans la page de code de la console : on passe en UTF-8 d'abord.
        Shell::Cmd => format!("@chcp 65001 >nul\r\n{}\r\n", body.replace('\n', "\r\n")).into_bytes(),
        Shell::Bash => {
            let mut s = body;
            if !s.ends_with('\n') {
                s.push('\n');
            }
            if keep_open {
                s.push_str("exec bash -i\n");
            }
            s.into_bytes()
        }
    }
}

/// Chemin écrit avec des `/` : accepté par Git Bash (`C:/Users/...`).
fn forward_slashes(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Ligne de commande qui exécute le script. `keep_open` : le shell reste ouvert ensuite.
/// Les arguments ne contiennent jamais de `;` (séparateur de commandes de `wt.exe`).
pub fn shell_argv(shell: Shell, script: &Path, keep_open: bool, powershell: &Path, bash: Option<&Path>) -> Result<Vec<String>, String> {
    let script_s = script.to_string_lossy().to_string();
    Ok(match shell {
        Shell::PowerShell => {
            let mut v = vec![powershell.to_string_lossy().to_string(), "-NoLogo".into()];
            if keep_open {
                v.push("-NoExit".into());
            }
            v.extend(["-ExecutionPolicy".into(), "Bypass".into(), "-File".into(), script_s]);
            v
        }
        Shell::Cmd => vec!["cmd.exe".into(), "/d".into(), if keep_open { "/k" } else { "/c" }.into(), script_s],
        Shell::Bash => {
            let bash = bash.ok_or(ERR_BASH_MISSING)?;
            vec![bash.to_string_lossy().to_string(), forward_slashes(script)]
        }
    })
}

const ERR_BASH_MISSING: &str = "Git Bash est introuvable : installez Git pour Windows (git-scm.com) pour exécuter les commandes bash, ou demandez à Claude la version PowerShell.";

/// Cherche un exécutable par son nom dans le PATH.
fn in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(name)).find(|p| p.is_file())
}

/// PowerShell 7 (`pwsh.exe`) s'il est installé, sinon Windows PowerShell.
fn find_powershell() -> PathBuf {
    in_path("pwsh.exe").unwrap_or_else(|| PathBuf::from("powershell.exe"))
}

/// Bash de Git pour Windows (jamais celui de `System32`, qui est WSL) : à côté de `git.exe`
/// dans le PATH, puis aux emplacements d'installation habituels.
fn find_bash() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(git) = in_path("git.exe") {
        // `Git\cmd\git.exe` ou `Git\bin\git.exe` (ou `Git\mingw64\bin\git.exe`).
        for up in git.ancestors().skip(2).take(2) {
            candidates.push(up.join(r"bin\bash.exe"));
        }
    }
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(pf) = std::env::var_os(var) {
            candidates.push(PathBuf::from(pf).join(r"Git\bin\bash.exe"));
        }
    }
    if let Some(local) = dirs::data_local_dir() {
        candidates.push(local.join(r"Programs\Git\bin\bash.exe"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Dossier des scripts temporaires (vidé de ses vieux scripts au passage).
fn scripts_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("claude-manager-run");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Dossier temporaire inaccessible : {e}"))?;
    let now = SystemTime::now();
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age > SCRIPT_TTL);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(dir)
}

/// Un identifiant de lancement ne contient que des lettres, chiffres et tirets.
fn validate_run_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err(format!("Identifiant de lancement invalide : {id}"))
    }
}

/// Écrit le script d'un bloc et renvoie son shell, son chemin et le dossier normalisé.
fn prepare(run_id: &str, lang: &str, code: &str, cwd: &str, keep_open: bool) -> Result<(Shell, PathBuf, String), String> {
    validate_run_id(run_id)?;
    let shell = Shell::from_lang(lang).ok_or_else(|| format!("Langue de bloc non exécutable : « {lang} »"))?;
    let body = script_body(lang, code);
    if body.trim().is_empty() {
        return Err("Le bloc est vide.".into());
    }
    if body.len() > MAX_SCRIPT {
        return Err("Le bloc est trop long pour être exécuté.".into());
    }
    let cwd = normalize_dir(cwd);
    if !Path::new(&cwd).is_dir() {
        return Err(format!("Le dossier de la conversation n'existe plus : {cwd}"));
    }
    let suffix = if keep_open { "-ext" } else { "" };
    let script = scripts_dir()?.join(format!("{run_id}{suffix}.{}", shell.extension()));
    std::fs::write(&script, script_file_content(shell, &body, keep_open)).map_err(|e| format!("Écriture du script impossible : {e}"))?;
    Ok((shell, script, cwd))
}

/// Ouvre une nouvelle fenêtre de terminal dans `cwd` qui exécute `argv` : Windows Terminal
/// s'il est présent, sinon une console classique.
fn open_window(terminal: crate::actions::Terminal, cwd: &str, argv: &[String]) -> Result<(), String> {
    let console = || -> std::io::Result<std::process::Child> {
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]).current_dir(cwd).env_remove("CLAUDECODE").env_remove("CLAUDE_CODE_ENTRYPOINT");
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NEW_CONSOLE);
        cmd.spawn()
    };
    let result = if terminal == crate::actions::Terminal::WindowsTerminal {
        Command::new("wt.exe")
            .args(["-w", "new", "-d", cwd])
            .args(argv)
            .current_dir(cwd)
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .spawn()
            .or_else(|_| console())
    } else {
        console()
    };
    result.map(|_| ()).map_err(|e| format!("Impossible d'ouvrir un terminal : {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_languages() {
        assert_eq!(Shell::from_lang("bash"), Some(Shell::Bash));
        assert_eq!(Shell::from_lang("Sh"), Some(Shell::Bash));
        assert_eq!(Shell::from_lang("console"), Some(Shell::Bash));
        assert_eq!(Shell::from_lang("powershell"), Some(Shell::PowerShell));
        assert_eq!(Shell::from_lang("PS1"), Some(Shell::PowerShell));
        assert_eq!(Shell::from_lang("cmd"), Some(Shell::Cmd));
        assert_eq!(Shell::from_lang("bat"), Some(Shell::Cmd));
        for no in ["", "rust", "ts", "json", "text", "python"] {
            assert_eq!(Shell::from_lang(no), None, "{no}");
        }
    }

    #[test]
    fn keeps_console_commands_only() {
        assert_eq!(script_body("console", "$ npm i\nadded 3 packages\n$ npm test\nok"), "npm i\nnpm test");
        // Pas de `$ ` : le bloc entier.
        assert_eq!(script_body("console", "npm i"), "npm i");
        assert_eq!(script_body("bash", "$ x"), "$ x");
    }

    #[test]
    fn writes_script_files() {
        let ps = script_file_content(Shell::PowerShell, "Write-Host é\nls", false);
        assert_eq!(&ps[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(std::str::from_utf8(&ps[3..]).unwrap(), "Write-Host é\r\nls");
        let cmd = String::from_utf8(script_file_content(Shell::Cmd, "dir\necho ok", false)).unwrap();
        assert_eq!(cmd, "@chcp 65001 >nul\r\ndir\r\necho ok\r\n");
        let sh = String::from_utf8(script_file_content(Shell::Bash, "ls\r\npwd", true)).unwrap();
        assert_eq!(sh, "ls\npwd\nexec bash -i\n");
        let sh = String::from_utf8(script_file_content(Shell::Bash, "ls\n", false)).unwrap();
        assert_eq!(sh, "ls\n");
    }

    #[test]
    fn builds_shell_argv() {
        let script = Path::new(r"C:\Temp\r\a1.ps1");
        let ps = Path::new("powershell.exe");
        let bash = Path::new(r"C:\Program Files\Git\bin\bash.exe");
        assert_eq!(
            shell_argv(Shell::PowerShell, script, true, ps, None).unwrap(),
            ["powershell.exe", "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", r"C:\Temp\r\a1.ps1"]
        );
        assert_eq!(
            shell_argv(Shell::PowerShell, script, false, ps, None).unwrap(),
            ["powershell.exe", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", r"C:\Temp\r\a1.ps1"]
        );
        assert_eq!(shell_argv(Shell::Cmd, Path::new(r"C:\t\a.cmd"), true, ps, None).unwrap(), ["cmd.exe", "/d", "/k", r"C:\t\a.cmd"]);
        assert_eq!(shell_argv(Shell::Cmd, Path::new(r"C:\t\a.cmd"), false, ps, None).unwrap(), ["cmd.exe", "/d", "/c", r"C:\t\a.cmd"]);
        assert_eq!(shell_argv(Shell::Bash, Path::new(r"C:\t\a.sh"), false, ps, Some(bash)).unwrap(), [r"C:\Program Files\Git\bin\bash.exe", "C:/t/a.sh"]);
        assert!(shell_argv(Shell::Bash, Path::new(r"C:\t\a.sh"), false, ps, None).is_err());
    }

    /// Exécute pour de vrai un bloc de chaque shell (script temporaire + ligne de commande),
    /// dans un dossier dont le nom a un espace et un accent. `cargo test -- --ignored`.
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn runs_each_shell() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("dossier é x");
        std::fs::create_dir_all(&cwd).unwrap();
        let cases = [
            ("powershell", "Write-Output \"ps é $((Get-Location).Path)\"\n$x = 2\nWrite-Output \"x=$x\""),
            ("cmd", "echo cmd é %CD%\necho deux"),
            ("bash", "echo \"bash é $(pwd)\"\nx=3; echo \"x=$x\""),
            ("console", "$ echo console\nsortie ignorée"),
        ];
        for (i, (lang, code)) in cases.iter().enumerate() {
            let id = format!("test-{i}");
            let (shell, script, dir) = prepare(&id, lang, code, &cwd.to_string_lossy(), false).unwrap();
            let argv = shell_argv(shell, &script, false, &find_powershell(), find_bash().as_deref()).unwrap();
            let out = Command::new(&argv[0]).args(&argv[1..]).current_dir(&dir).output().unwrap();
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            println!("--- {lang}: {argv:?}\n{text}{}", String::from_utf8_lossy(&out.stderr));
            assert!(out.status.success(), "{lang}");
            match *lang {
                "powershell" => assert!(text.contains("ps ") && text.contains(" x") && text.contains("x=2"), "{text}"),
                "cmd" => assert!(text.contains("cmd ") && text.contains(" x") && text.contains("deux"), "{text}"),
                "bash" => assert!(text.contains("bash ") && text.contains(" x") && text.contains("x=3"), "{text}"),
                _ => assert!(text.contains("console") && !text.contains("ignor"), "{text}"),
            }
        }
    }

    #[test]
    fn validates_run_ids() {
        assert!(validate_run_id("8d0c1f2e-aaaa-4bbb-8ccc-123456789abc").is_ok());
        for bad in ["", "a b", "../x", r"a\b", "a;b"] {
            assert!(validate_run_id(bad).is_err(), "{bad}");
        }
    }
}

/// Commandes Tauri (voir `src/runner.ts` côté interface).
pub mod commands {
    use super::*;
    use tauri::{AppHandle, State};

    /// Exécute un bloc dans un terminal intégré, sous la clé `run-<run_id>`.
    #[tauri::command(async)]
    pub fn run_integrated(
        app: AppHandle,
        ptys: State<PtyManager>,
        run_id: String,
        lang: String,
        code: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> Result<PtyInfo, String> {
        let (shell, script, cwd) = prepare(&run_id, &lang, &code, &cwd, false)?;
        let argv = shell_argv(shell, &script, false, &find_powershell(), find_bash().as_deref())?;
        ptys.launch(&app, LaunchSpec { key: format!("run-{run_id}"), cwd, program: Program::Raw(argv), cols, rows })
    }

    /// Exécute un bloc dans une nouvelle fenêtre de terminal, qui reste ouverte ensuite.
    #[tauri::command(async)]
    pub fn run_external(state: State<crate::AppState>, run_id: String, lang: String, code: String, cwd: String) -> Result<(), String> {
        let (shell, script, cwd) = prepare(&run_id, &lang, &code, &cwd, true)?;
        let argv = shell_argv(shell, &script, true, &find_powershell(), find_bash().as_deref())?;
        open_window(state.terminal, &cwd, &argv)
    }
}
