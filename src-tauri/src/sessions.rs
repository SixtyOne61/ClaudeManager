//! Lecture des sessions Claude Code, en LECTURE SEULE.
//!
//! Organisation sur disque (vérifiée sur la machine) :
//!
//! ```text
//! ~/.claude/projects/
//!   C--Users-moi-Projets-Foo/              <- chemin du projet, chaque caractère non alphanumérique remplacé par '-'
//!     <session-id>.jsonl                   <- une conversation, un objet JSON par ligne
//!     <session-id>/                        <- facultatif : subagents/, tool-results/, custom-title.json
//!     memory/                              <- mémoire du projet (ignorée ici)
//! ```
//!
//! L'encodage du nom de dossier est irréversible (`a-b` et `a\b` donnent la même chose) :
//! le vrai chemin du projet est lu dans le champ `cwd` des lignes de la session.
//!
//! Les fichiers peuvent dépasser 10 Mo. Pour rester rapide, on ne décode que les lignes
//! dont le type nous intéresse (repérées par une simple recherche de sous-chaîne), et le
//! contenu des messages de l'assistant n'est jamais décodé.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Longueur maximale d'un titre calculé à partir du premier message.
const TITLE_MAX_CHARS: usize = 90;

/// Origine du titre affiché, pour que l'interface puisse le signaler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TitleSource {
    /// Titre donné à la session (`custom-title`, celui de l'appli desktop / `/rename`).
    Custom,
    /// Titre généré automatiquement (`ai-title`).
    Ai,
    /// Premier message de l'utilisateur.
    Prompt,
    /// Rien d'exploitable : on affiche l'identifiant.
    None,
}

/// Résumé d'une conversation, envoyé à l'interface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    /// Nom du dossier projet encodé où est rangé le fichier (clé de stockage). Pour une
    /// conversation de worktree, ce n'est pas la clé du projet affiché (le parent).
    pub project_key: String,
    /// Premier répertoire de travail rencontré : c'est là qu'il faut relancer `claude --resume`.
    pub cwd: Option<String>,
    pub title: String,
    pub title_source: TitleSource,
    pub first_prompt: Option<String>,
    /// Horodatages ISO 8601 (UTC) de la première et de la dernière ligne datée.
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// Messages utilisateur (texte) + réponses de l'assistant (dédoublonnées par id).
    pub message_count: u32,
    pub file_size: u64,
    /// Date de modification du fichier (ms depuis l'époque Unix).
    pub modified_ms: u64,
    /// Nombre de lignes illisibles ignorées (fichier corrompu ou en cours d'écriture).
    pub skipped_lines: u32,
    /// Worktree de la conversation, si elle est rangée sous son projet parent
    /// (renseigné au regroupement, jamais lu depuis le fichier).
    #[serde(default)]
    pub worktree: Option<crate::worktrees::WorktreeInfo>,
}

// ---------------------------------------------------------------------------
// Décodage tolérant d'une ligne
// ---------------------------------------------------------------------------

/// Désérialise un champ sans jamais échouer : un type inattendu donne `None`
/// au lieu de rejeter toute la ligne.
fn lenient<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).ok())
}

/// Sous-ensemble utile d'une ligne `.jsonl`. Tous les champs sont facultatifs.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawLine {
    #[serde(rename = "type", deserialize_with = "lenient")]
    kind: Option<String>,
    #[serde(deserialize_with = "lenient")]
    is_meta: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    is_sidechain: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    cwd: Option<String>,
    #[serde(deserialize_with = "lenient")]
    timestamp: Option<String>,
    #[serde(deserialize_with = "lenient")]
    custom_title: Option<String>,
    #[serde(deserialize_with = "lenient")]
    ai_title: Option<String>,
    /// Gardé brut : on ne le décode que pour les messages utilisateur.
    message: Option<Box<RawValue>>,
}

/// Message de l'assistant : seul l'id nous intéresse (le contenu reste ignoré).
#[derive(Deserialize, Default)]
#[serde(default)]
struct AssistantMessage {
    #[serde(deserialize_with = "lenient")]
    id: Option<String>,
}

/// Message utilisateur : le contenu est soit une chaîne, soit une liste de blocs.
#[derive(Deserialize, Default)]
#[serde(default)]
struct UserMessage {
    content: Option<Value>,
}

/// Types de lignes à décoder. Les autres (requêtes API, historique de fichiers…)
/// sont ignorés sans être analysés.
const INTERESTING: [&str; 4] = ["user", "assistant", "custom-title", "ai-title"];

/// Repère rapidement (sans décoder le JSON) une ligne contenant `"type": "<intéressant>"`,
/// espaces autour des deux-points tolérés. Un faux positif ne coûte qu'un décodage.
fn is_interesting(line: &str) -> bool {
    let mut rest = line;
    while let Some(pos) = rest.find("\"type\"") {
        rest = &rest[pos + 6..];
        let after = rest.trim_start();
        let Some(after) = after.strip_prefix(':') else { continue };
        let Some(value) = after.trim_start().strip_prefix('"') else { continue };
        if INTERESTING
            .iter()
            .any(|t| value.strip_prefix(t).is_some_and(|r| r.starts_with('"')))
        {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Nettoyage du texte des messages utilisateur
// ---------------------------------------------------------------------------

/// Extrait le texte d'un contenu de message (chaîne, ou blocs `{type:"text"}`).
/// Les blocs `tool_result` / `image` sont ignorés.
fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Sections injectées par Claude Code qui ne sont pas écrites par l'utilisateur :
/// on les retire entièrement (balises + contenu).
const NOISE_SECTIONS: [&str; 6] = [
    "system-reminder",
    "local-command-stdout",
    "local-command-stderr",
    "local-command-caveat",
    "ide_opened_file",
    "ide_selection",
];

/// Retire `<tag ...>...</tag>` (toutes les occurrences) d'un texte.
fn remove_section(text: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        match rest[start..].find(&close) {
            Some(end) => rest = &rest[start + end + close.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Renvoie le contenu de la première balise `<tag>...</tag>`, s'il y en a une.
fn tag_content<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim())
}

/// Retire les balises restantes (`<pasted_content id="…">`, `</x>`…) en gardant leur contenu.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '<' {
            // Une balise commence par une lettre ou '/' et se termine par '>' assez vite.
            let next = text[i + 1..].chars().next();
            if matches!(next, Some(n) if n.is_ascii_alphabetic() || n == '/') {
                if let Some(end) = text[i..].find('>').filter(|&e| e < 200) {
                    // Avance jusqu'après le '>'.
                    while let Some(&(j, _)) = chars.peek() {
                        if j > i + end {
                            break;
                        }
                        chars.next();
                    }
                    out.push(' ');
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// Transforme le texte brut d'un message utilisateur en texte lisible.
/// Renvoie `None` si le message n'a rien d'humain (vide, interruption…).
pub fn clean_prompt(raw: &str) -> Option<String> {
    // Commande slash : "<command-name>/review</command-name><command-args>x</command-args>".
    if let Some(name) = tag_content(raw, "command-name") {
        let args = tag_content(raw, "command-args").unwrap_or("");
        let s = format!("{name} {args}");
        return Some(collapse_ws(&s)).filter(|s| !s.is_empty());
    }
    let mut text = raw.to_string();
    for tag in NOISE_SECTIONS {
        text = remove_section(&text, tag);
    }
    let text = collapse_ws(&strip_tags(&text));
    if text.is_empty() || text.starts_with("[Request interrupted") || text.starts_with("Caveat:") {
        return None;
    }
    Some(text)
}

/// Remplace toute suite d'espaces / retours à la ligne par un seul espace.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Tronque proprement (sur une frontière de caractère) avec une ellipse.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

// ---------------------------------------------------------------------------
// Lecture d'une session
// ---------------------------------------------------------------------------

/// Encode un chemin comme le fait Claude Code pour nommer le dossier projet.
pub fn encode_project_path(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Date de modification et taille d'un fichier.
pub fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((mtime, meta.len()))
}

/// Lit un fichier `.jsonl` et en extrait un [`SessionInfo`].
///
/// Ne plante jamais sur une ligne invalide : elle est comptée dans `skipped_lines`
/// et ignorée. Renvoie `None` seulement si le fichier ne peut pas être ouvert.
pub fn read_session(path: &Path, project_key: &str) -> Option<SessionInfo> {
    let id = path.file_stem()?.to_string_lossy().to_string();
    let (modified_ms, file_size) = file_stamp(path)?;
    let file = File::open(path).ok()?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);

    let mut cwd: Option<String> = None;
    let mut created_at: Option<String> = None;
    let mut updated_at: Option<String> = None;
    let mut custom_title: Option<String> = None;
    let mut ai_title: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut user_messages: u32 = 0;
    let mut assistant_ids: HashSet<String> = HashSet::new();
    let mut assistant_without_id: u32 = 0;
    let mut skipped_lines: u32 = 0;

    // Lecture en octets : une ligne en UTF-8 invalide ne doit pas arrêter la lecture.
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => {
                // Erreur d'E/S (fichier verrouillé, tronqué…) : on garde ce qu'on a lu.
                skipped_lines += 1;
                break;
            }
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            skipped_lines += 1;
            continue;
        };
        let line = line.trim();
        if line.is_empty() || !is_interesting(line) {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<RawLine>(line) else {
            // Ligne tronquée (écriture en cours) ou JSON invalide : ignorée.
            skipped_lines += 1;
            continue;
        };

        match raw.kind.as_deref() {
            Some("custom-title") => {
                // Le dernier titre gagne (la session peut être renommée plusieurs fois).
                if let Some(t) = raw.custom_title.filter(|t| !t.trim().is_empty()) {
                    custom_title = Some(t.trim().to_string());
                }
                continue;
            }
            Some("ai-title") => {
                if let Some(t) = raw.ai_title.filter(|t| !t.trim().is_empty()) {
                    ai_title = Some(t.trim().to_string());
                }
                continue;
            }
            Some("user") | Some("assistant") => {}
            _ => continue,
        }

        // Les sous-agents (sidechain) ne font pas partie de la conversation principale.
        if raw.is_sidechain == Some(true) {
            continue;
        }
        if cwd.is_none() {
            cwd = raw.cwd.clone().filter(|c| !c.is_empty());
        }
        if let Some(ts) = raw.timestamp.as_deref() {
            // Format ISO 8601 en UTC : la comparaison de chaînes suffit.
            if created_at.as_deref().is_none_or(|c| ts < c) {
                created_at = Some(ts.to_string());
            }
            if updated_at.as_deref().is_none_or(|u| ts > u) {
                updated_at = Some(ts.to_string());
            }
        }

        if raw.kind.as_deref() == Some("assistant") {
            let msg_id = raw
                .message
                .as_deref()
                .and_then(|m| serde_json::from_str::<AssistantMessage>(m.get()).ok())
                .and_then(|m| m.id);
            match msg_id {
                // Une réponse est découpée en plusieurs lignes partageant le même id.
                Some(mid) => {
                    assistant_ids.insert(mid);
                }
                None => assistant_without_id += 1,
            }
            continue;
        }

        // Message utilisateur.
        if raw.is_meta == Some(true) {
            continue;
        }
        let content = raw
            .message
            .as_deref()
            .and_then(|m| serde_json::from_str::<UserMessage>(m.get()).ok())
            .and_then(|m| m.content);
        let Some(content) = content else { continue };
        let text = content_text(&content);
        // Un message sans texte est un résultat d'outil, pas un message humain.
        let Some(clean) = clean_prompt(&text) else { continue };
        user_messages += 1;
        if first_prompt.is_none() {
            first_prompt = Some(truncate(&clean, 300));
        }
    }

    // Titre enregistré à côté du fichier par l'appli desktop, si absent du .jsonl.
    if custom_title.is_none() {
        let sidecar = path.with_extension("").join("custom-title.json");
        if let Ok(text) = fs::read_to_string(sidecar) {
            custom_title = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("customTitle")?.as_str().map(str::to_string))
                .filter(|t| !t.trim().is_empty());
        }
    }

    let (title, title_source) = if let Some(t) = custom_title {
        (t, TitleSource::Custom)
    } else if let Some(t) = ai_title {
        (t, TitleSource::Ai)
    } else if let Some(p) = &first_prompt {
        (truncate(p, TITLE_MAX_CHARS), TitleSource::Prompt)
    } else {
        (format!("Session {}", &id[..id.len().min(8)]), TitleSource::None)
    };

    Some(SessionInfo {
        id,
        project_key: project_key.to_string(),
        cwd,
        title,
        title_source,
        first_prompt,
        created_at,
        updated_at,
        message_count: user_messages + assistant_ids.len() as u32 + assistant_without_id,
        file_size,
        modified_ms,
        skipped_lines,
        worktree: None,
    })
}

/// Recherche plein texte (insensible à la casse) dans les messages d'une session.
/// Ne lit que les lignes qui contiennent déjà la requête, puis vérifie dans le texte décodé.
pub fn session_contains(path: &Path, query_lower: &str) -> bool {
    let Ok(file) = File::open(path) else { return false };
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return false,
            Ok(_) => {}
        }
        let Ok(line) = std::str::from_utf8(&buf) else { continue };
        if !line.to_lowercase().contains(query_lower) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let kind = v.get("type").and_then(Value::as_str);
        if !matches!(kind, Some("user") | Some("assistant")) {
            continue;
        }
        if let Some(content) = v.pointer("/message/content") {
            if content_text(content).to_lowercase().contains(query_lower) {
                return true;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_jsonl(dir: &Path, name: &str, lines: &[&str]) -> std::path::PathBuf {
        let p = dir.join(name);
        let mut f = File::create(&p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }

    #[test]
    fn encodes_paths_like_claude_code() {
        assert_eq!(
            encode_project_path(r"C:\Users\olivi\OneDrive\Desktop\Projects\SpaceL\.claude\worktrees\x"),
            "C--Users-olivi-OneDrive-Desktop-Projects-SpaceL--claude-worktrees-x"
        );
        assert_eq!(encode_project_path(r"Z:\"), "Z--");
    }

    #[test]
    fn reads_title_dates_count_and_survives_corrupt_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_jsonl(
            dir.path(),
            "abc.jsonl",
            &[
                r#"{"type":"queue-operation","operation":"enqueue"}"#,
                r#"{"type":"user","isMeta":true,"cwd":"C:\\x","timestamp":"2026-01-01T09:00:00Z","message":{"content":"Caveat: meta"}}"#,
                r#"{"type":"user","cwd":"C:\\proj","timestamp":"2026-01-01T10:00:00Z","message":{"content":[{"type":"text","text":"<system-reminder>bruit</system-reminder>Bonjour   le\nmonde"}]}}"#,
                r#"{"type":"assistant","timestamp":"2026-01-01T10:00:05Z","message":{"id":"m1","content":[{"type":"text","text":"a"}]}}"#,
                r#"{"type":"assistant","timestamp":"2026-01-01T10:00:06Z","message":{"id":"m1","content":[{"type":"tool_use"}]}}"#,
                r#"{"type":"user","timestamp":"2026-01-01T10:00:07Z","message":{"content":[{"type":"tool_result","content":"x"}]}}"#,
                r#"{"type":"user","isSidechain":true,"timestamp":"2026-01-01T10:00:08Z","message":{"content":"sous-agent"}}"#,
                r#"{"type":"assistant","isMeta":null,"timestamp":"2026-01-01T11:00:00Z","message":{"id":"m2"}}"#,
                r#"{"type":"user","message":{"content":"ligne tronq"#,
                "pas du json du tout \"type\":\"user\"",
                r#"{"type":"custom-title","customTitle":"Ancien titre"}"#,
                r#"{"type":"custom-title","customTitle":"Mon titre"}"#,
            ],
        );
        let s = read_session(&p, "C--proj").unwrap();
        assert_eq!(s.id, "abc");
        assert_eq!(s.title, "Mon titre");
        assert_eq!(s.title_source, TitleSource::Custom);
        assert_eq!(s.first_prompt.as_deref(), Some("Bonjour le monde"));
        // cwd des lignes meta comprises : la première ligne datée utile fixe le cwd.
        assert_eq!(s.cwd.as_deref(), Some(r"C:\x"));
        assert_eq!(s.created_at.as_deref(), Some("2026-01-01T09:00:00Z"));
        assert_eq!(s.updated_at.as_deref(), Some("2026-01-01T11:00:00Z"));
        // 1 message utilisateur + 2 réponses (m1, m2).
        assert_eq!(s.message_count, 3);
        assert_eq!(s.skipped_lines, 2);
    }

    #[test]
    fn falls_back_to_ai_title_then_prompt_then_id() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_jsonl(
            dir.path(),
            "s1.jsonl",
            &[r#"{"type":"ai-title","aiTitle":"Titre IA"}"#, r#"{"type":"user","message":{"content":"x"}}"#],
        );
        assert_eq!(read_session(&p, "k").unwrap().title, "Titre IA");

        let p = write_jsonl(
            dir.path(),
            "s2.jsonl",
            &[r#"{"type":"user","message":{"content":"<command-name>/review</command-name><command-args>main</command-args>"}}"#],
        );
        let s = read_session(&p, "k").unwrap();
        assert_eq!((s.title.as_str(), s.title_source), ("/review main", TitleSource::Prompt));

        let p = write_jsonl(dir.path(), "0123456789.jsonl", &["{corrompu"]);
        let s = read_session(&p, "k").unwrap();
        assert_eq!(s.title, "Session 01234567");
        assert_eq!(s.message_count, 0);
    }

    #[test]
    fn reads_sidecar_custom_title() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_jsonl(dir.path(), "sid.jsonl", &[r#"{"type":"user","message":{"content":"hello"}}"#]);
        fs::create_dir(dir.path().join("sid")).unwrap();
        fs::write(dir.path().join("sid").join("custom-title.json"), r#"{"customTitle":"Depuis le fichier"}"#).unwrap();
        assert_eq!(read_session(&p, "k").unwrap().title, "Depuis le fichier");
    }

    #[test]
    fn prefilter_tolerates_spaces() {
        assert!(is_interesting(r#"{"type":"user"}"#));
        assert!(is_interesting(r#"{"a":1, "type" : "assistant", "b":2}"#));
        assert!(is_interesting(r#"{"message":{"type":"text"},"type": "custom-title"}"#));
        assert!(!is_interesting(r#"{"type":"user-prompt"}"#));
        assert!(!is_interesting(r#"{"type":"api-request","x":"\"type\":\"user\""}"#));
    }

    #[test]
    fn cleans_prompts() {
        assert_eq!(clean_prompt("[Request interrupted by user]"), None);
        assert_eq!(clean_prompt("<local-command-stdout>x</local-command-stdout>"), None);
        assert_eq!(
            clean_prompt("<pasted_content id=\"1\">\nJe veux une appli</pasted_content>").as_deref(),
            Some("Je veux une appli")
        );
        assert_eq!(clean_prompt("a < b et c > d").as_deref(), Some("a < b et c > d"));
    }

    #[test]
    fn full_text_search() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_jsonl(
            dir.path(),
            "s.jsonl",
            &[
                r#"{"type":"user","message":{"content":"Parle-moi du Générateur"}}"#,
                r#"{"type":"api-request","params":"secret générateur"}"#,
            ],
        );
        assert!(session_contains(&p, "générateur"));
        assert!(!session_contains(&p, "secret"));
    }
}
