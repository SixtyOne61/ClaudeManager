//! Recherche dans le contenu des conversations, en LECTURE SEULE.
//!
//! Seul le texte écrit par l'utilisateur et le texte des réponses de l'agent est cherché :
//! pas les résultats d'outils, pas les appels d'outils, pas la réflexion de l'agent, pas les
//! lignes techniques (requêtes, historique de fichiers…), pas les sous-agents.
//! La recherche ignore la casse et les accents (« generateur » trouve « Générateur »).
//!
//! Pour rester rapide sur des fichiers de plusieurs dizaines de Mo, chaque ligne est d'abord
//! comparée brute (après repliement casse/accents, sans décoder le JSON) à un mot de la
//! requête ; seules les lignes candidates sont décodées. Les fichiers sont lus en parallèle.

use crate::config::ArchiveEntry;
use crate::scanner::ProjectInfo;
use crate::sessions::clean_prompt;
use serde::Serialize;
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

/// Longueur minimale d'une requête (en caractères, après nettoyage).
pub const MIN_QUERY_CHARS: usize = 2;
/// Nombre maximal de conversations renvoyées.
const MAX_SESSIONS: usize = 300;
/// Nombre maximal d'extraits gardés par conversation (les suivants sont seulement comptés).
const MAX_HITS_PER_SESSION: usize = 3;
/// Contexte affiché autour du mot trouvé (en caractères).
const EXCERPT_BEFORE: usize = 60;
const EXCERPT_AFTER: usize = 110;

/// Numéro de la dernière recherche lancée : une recherche plus ancienne s'arrête dès
/// qu'une nouvelle commence (l'utilisateur tape encore).
static GENERATION: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Résultats envoyés à l'interface
// ---------------------------------------------------------------------------

/// Extrait de message découpé autour du mot trouvé, pour le mettre en évidence.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Excerpt {
    pub before: String,
    pub matched: String,
    pub after: String,
}

/// Un message qui contient la recherche.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// `user` ou `assistant`.
    pub role: &'static str,
    /// Numéro de la ligne dans le `.jsonl` (à partir de 0), pour retrouver le message.
    pub line: u32,
    /// Identifiant (`uuid`) de la ligne, plus stable que son numéro.
    pub uuid: Option<String>,
    pub excerpt: Excerpt,
}

/// Une conversation qui contient la recherche.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHits {
    pub project_key: String,
    pub project_path: Option<String>,
    pub session_id: String,
    pub title: String,
    pub updated_at: Option<String>,
    /// Conversation archivée (rangée dans le dossier d'archive de l'appli).
    pub archived: bool,
    /// Nombre de messages qui contiennent la recherche.
    pub match_count: u32,
    /// Les premiers messages trouvés (au plus [`MAX_HITS_PER_SESSION`]).
    pub hits: Vec<Hit>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Conversations trouvées, de la plus récente à la plus ancienne.
    pub sessions: Vec<SessionHits>,
    /// Plus de [`MAX_SESSIONS`] conversations trouvées : la liste est coupée.
    pub truncated: bool,
    /// Recherche abandonnée parce qu'une plus récente a commencé.
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

/// Une conversation à parcourir.
#[derive(Debug, Clone)]
pub struct Target {
    pub project_key: String,
    pub project_path: Option<String>,
    pub session_id: String,
    pub title: String,
    pub updated_at: Option<String>,
    pub archived: bool,
    pub file: PathBuf,
}

// ---------------------------------------------------------------------------
// Repliement casse / accents
// ---------------------------------------------------------------------------

/// Lettre de base d'un caractère accentué (latin), ou `None` s'il n'a pas d'équivalent.
/// Le caractère reçu est déjà en minuscule.
fn strip_accent(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'æ' => "ae",
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => "c",
        'ď' | 'đ' | 'ð' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => "e",
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => "g",
        'ĥ' | 'ħ' => "h",
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => "i",
        'ĵ' => "j",
        'ķ' => "k",
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => "l",
        'ñ' | 'ń' | 'ņ' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => "o",
        'œ' => "oe",
        'ŕ' | 'ŗ' | 'ř' => "r",
        'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => "s",
        'ß' => "ss",
        'ţ' | 'ť' | 'ŧ' | 'ț' => "t",
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => "u",
        'ŵ' => "w",
        'ý' | 'ÿ' | 'ŷ' => "y",
        'ź' | 'ż' | 'ž' => "z",
        // Typographie française : apostrophe courbe et espaces insécables.
        '\u{2019}' | '\u{2018}' => "'",
        '\u{00A0}' | '\u{202F}' => " ",
        _ => return None,
    })
}

/// Ajoute à `out` la forme repliée de `c` (minuscule, sans accent).
#[inline]
fn fold_char(c: char, out: &mut String) {
    if c.is_ascii() {
        out.push(c.to_ascii_lowercase());
        return;
    }
    // Accents combinants (texte décomposé) : simplement retirés.
    if ('\u{0300}'..='\u{036F}').contains(&c) {
        return;
    }
    for lc in c.to_lowercase() {
        match strip_accent(lc) {
            Some(base) => out.push_str(base),
            None => out.push(lc),
        }
    }
}

/// Forme repliée d'un texte : minuscules, sans accents.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    fold_into(text, &mut out);
    out
}

/// Comme [`fold`], dans un tampon réutilisé (vidé d'abord).
fn fold_into(text: &str, out: &mut String) {
    out.clear();
    for c in text.chars() {
        fold_char(c, out);
    }
}

/// Forme repliée avec, pour chaque octet du résultat, la plage d'octets du caractère
/// d'origine : permet de retrouver le mot trouvé dans le texte affiché.
fn fold_with_map(text: &str) -> (String, Vec<(usize, usize)>) {
    let mut out = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len());
    for (i, c) in text.char_indices() {
        fold_char(c, &mut out);
        map.resize(out.len(), (i, i + c.len_utf8()));
    }
    (out, map)
}

/// Remplace toute suite d'espaces par un seul espace.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// Requête
// ---------------------------------------------------------------------------

/// Requête préparée : texte replié, et morceau utilisé pour filtrer les lignes brutes.
#[derive(Debug, Clone)]
pub struct Query {
    folded: String,
    /// Plus long morceau de la requête qui apparaît tel quel dans le JSON brut (sans espace,
    /// guillemet ni barre oblique inverse, que le JSON échappe). `None` : pas de filtre.
    raw_filter: Option<String>,
}

impl Query {
    /// Prépare une requête. `None` si elle est trop courte.
    pub fn new(query: &str) -> Option<Self> {
        let folded = fold(&collapse_ws(query));
        if folded.chars().count() < MIN_QUERY_CHARS {
            return None;
        }
        let raw_filter = folded
            .split(|c: char| c.is_whitespace() || c == '"' || c == '\\' || c.is_control())
            .max_by_key(|s| s.len())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        Some(Self { folded, raw_filter })
    }
}

// ---------------------------------------------------------------------------
// Extraction du texte cherchable
// ---------------------------------------------------------------------------

/// Texte cherchable d'une ligne `.jsonl` décodée : `(rôle, texte)`, ou `None` si la ligne
/// n'est pas un message de l'utilisateur ou de l'agent.
///
/// - utilisateur : blocs `text` (ou chaîne), nettoyés des sections injectées par Claude Code ;
///   les résultats d'outils et images sont ignorés, comme les messages `isMeta` et les résumés
///   de compaction ;
/// - agent : blocs `text` seulement (ni `tool_use`, ni `thinking`) ;
/// - sous-agents (`isSidechain`) ignorés : ils ne font pas partie de la conversation.
pub fn searchable_text(v: &Value) -> Option<(&'static str, String)> {
    let flag = |k: &str| v.get(k).and_then(Value::as_bool) == Some(true);
    if flag("isSidechain") {
        return None;
    }
    let content = v.pointer("/message/content")?;
    match v.get("type").and_then(Value::as_str)? {
        "user" => {
            if flag("isMeta") || flag("isCompactSummary") {
                return None;
            }
            clean_prompt(&text_blocks(content)).map(|t| ("user", t))
        }
        "assistant" => {
            let t = collapse_ws(&text_blocks(content));
            (!t.is_empty()).then_some(("assistant", t))
        }
        _ => None,
    }
}

/// Texte d'un contenu de message : la chaîne, ou les blocs `{type:"text"}` réunis.
fn text_blocks(content: &Value) -> String {
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

// ---------------------------------------------------------------------------
// Extrait
// ---------------------------------------------------------------------------

/// Cherche la requête (déjà repliée) dans `text` et découpe un extrait autour de la
/// première occurrence. `None` si le texte ne contient pas la requête.
pub fn excerpt(text: &str, folded_query: &str) -> Option<Excerpt> {
    let (folded, map) = fold_with_map(text);
    let pos = folded.find(folded_query)?;
    let start = map[pos].0;
    let end = map[pos + folded_query.len() - 1].1;

    // Contexte : quelques dizaines de caractères, coupés si possible sur un espace.
    let before_full = &text[..start];
    let after_full = &text[end..];
    let mut before = tail_chars(before_full, EXCERPT_BEFORE);
    if before.len() < before_full.len() {
        if let Some(sp) = before.find(' ') {
            before = &before[sp + 1..];
        }
    }
    let mut after = head_chars(after_full, EXCERPT_AFTER);
    if after.len() < after_full.len() {
        if let Some(sp) = after.rfind(' ') {
            after = &after[..sp];
        }
    }
    let ellipsis_before = if before.len() < before_full.len() { "…" } else { "" };
    let ellipsis_after = if after.len() < after_full.len() { "…" } else { "" };
    Some(Excerpt {
        before: format!("{ellipsis_before}{before}"),
        matched: text[start..end].to_string(),
        after: format!("{after}{ellipsis_after}"),
    })
}

/// Les `n` derniers caractères de `s`.
fn tail_chars(s: &str, n: usize) -> &str {
    match s.char_indices().rev().nth(n.saturating_sub(1)) {
        Some((i, _)) if n > 0 => &s[i..],
        _ if n == 0 => "",
        _ => s,
    }
}

/// Les `n` premiers caractères de `s`.
fn head_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

// ---------------------------------------------------------------------------
// Lecture d'un fichier
// ---------------------------------------------------------------------------

/// Parcourt un `.jsonl` et renvoie `(nombre de messages trouvés, premiers extraits)`.
/// S'arrête au premier message trouvé si `max_hits == 0` (simple test de présence),
/// ou dès que `cancelled()` devient vrai.
fn scan_file(path: &Path, q: &Query, max_hits: usize, cancelled: &dyn Fn() -> bool) -> (u32, Vec<Hit>) {
    let mut count = 0u32;
    let mut hits = Vec::new();
    let Ok(file) = File::open(path) else { return (0, hits) };
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut buf: Vec<u8> = Vec::new();
    let mut folded_line = String::new();
    let mut line_no: u32 = 0;
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let n = line_no;
        line_no += 1;
        if n % 2048 == 0 && cancelled() {
            break;
        }
        // UTF-8 invalide : ligne ignorée (comme à la lecture des conversations).
        let Ok(line) = std::str::from_utf8(&buf) else { continue };
        if let Some(filter) = &q.raw_filter {
            fold_into(line, &mut folded_line);
            if !folded_line.contains(filter.as_str()) {
                continue;
            }
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some((role, text)) = searchable_text(&v) else { continue };
        let Some(ex) = excerpt(&text, &q.folded) else { continue };
        count += 1;
        if max_hits == 0 {
            break;
        }
        if hits.len() < max_hits {
            let uuid = v.get("uuid").and_then(Value::as_str).map(str::to_string);
            hits.push(Hit { role, line: n, uuid, excerpt: ex });
        }
    }
    (count, hits)
}

/// La conversation contient-elle la recherche ? (recherche limitée à un projet)
pub fn file_matches(path: &Path, q: &Query) -> bool {
    scan_file(path, q, 0, &|| false).0 > 0
}

// ---------------------------------------------------------------------------
// Recherche globale
// ---------------------------------------------------------------------------

/// Conversations à parcourir : celles des projets, puis les archives (signalées comme telles).
pub fn targets(root: &Path, projects: &[ProjectInfo], archives: &[ArchiveEntry]) -> Vec<Target> {
    let mut out: Vec<Target> = Vec::new();
    for p in projects {
        for s in &p.sessions {
            out.push(Target {
                project_key: p.key.clone(),
                project_path: p.path.clone(),
                session_id: s.id.clone(),
                title: s.title.clone(),
                updated_at: s.updated_at.clone(),
                archived: false,
                // Le fichier est rangé sous la clé de stockage de la conversation, qui diffère
                // de celle du projet pour une conversation de worktree.
                file: root.join(&s.project_key).join(format!("{}.jsonl", s.id)),
            });
        }
    }
    let live: std::collections::HashSet<String> = out.iter().map(|t| t.session_id.clone()).collect();
    for a in archives.iter().filter(|a| !live.contains(&a.session_id) && !a.archived_file.is_empty()) {
        out.push(Target {
            project_key: a.project_key.clone(),
            project_path: a.project_path.clone(),
            session_id: a.session_id.clone(),
            title: a.title.clone(),
            updated_at: a.updated_at.clone(),
            archived: true,
            file: PathBuf::from(&a.archived_file),
        });
    }
    out
}

/// Cherche `query` dans toutes les conversations données, en parallèle.
/// Une recherche lancée ensuite interrompt celle-ci (résultat marqué `cancelled`).
pub fn search(targets: &[Target], query: &str) -> SearchResult {
    let started = std::time::Instant::now();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(q) = Query::new(query) else { return SearchResult::default() };
    let cancelled = || GENERATION.load(Ordering::Relaxed) != generation;

    // Les plus gros fichiers d'abord : ils dominent le temps total.
    let mut order: Vec<(u64, usize)> = targets
        .iter()
        .enumerate()
        .map(|(i, t)| (std::fs::metadata(&t.file).map(|m| m.len()).unwrap_or(0), i))
        .collect();
    order.sort_unstable_by(|a, b| b.0.cmp(&a.0));

    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(order.len()).max(1);
    let next = AtomicUsize::new(0);
    let found: Mutex<Vec<SessionHits>> = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                if cancelled() {
                    break;
                }
                let n = next.fetch_add(1, Ordering::Relaxed);
                let Some(&(_, i)) = order.get(n) else { break };
                let t = &targets[i];
                let (count, hits) = scan_file(&t.file, &q, MAX_HITS_PER_SESSION, &cancelled);
                if count > 0 {
                    found.lock().unwrap().push(SessionHits {
                        project_key: t.project_key.clone(),
                        project_path: t.project_path.clone(),
                        session_id: t.session_id.clone(),
                        title: t.title.clone(),
                        updated_at: t.updated_at.clone(),
                        archived: t.archived,
                        match_count: count,
                        hits,
                    });
                }
            });
        }
    });

    let mut sessions = found.into_inner().unwrap();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.session_id.cmp(&b.session_id)));
    let truncated = sessions.len() > MAX_SESSIONS;
    sessions.truncate(MAX_SESSIONS);
    SearchResult { sessions, truncated, cancelled: cancelled(), elapsed_ms: started.elapsed().as_millis() as u64 }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_jsonl(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
        let p = dir.join(name);
        let mut f = File::create(&p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }

    fn text_of(line: &str) -> Option<(&'static str, String)> {
        searchable_text(&serde_json::from_str(line).unwrap())
    }

    #[test]
    fn folds_case_and_accents() {
        assert_eq!(fold("Générateur À ÉTÉ Œuvre"), "generateur a ete oeuvre");
        assert_eq!(fold("Straße naïve Ça"), "strasse naive ca");
        // Texte décomposé (e + accent combinant) et typographie française.
        assert_eq!(fold("e\u{0301}te\u{0301}"), "ete");
        assert_eq!(fold("l\u{2019}appli\u{202F}:"), "l'appli :");
        // Les écritures non latines restent cherchables.
        assert_eq!(fold("Привет 日本"), "привет 日本");
    }

    #[test]
    fn prepares_query() {
        assert!(Query::new(" a ").is_none());
        let q = Query::new("  Mise   à jour ").unwrap();
        assert_eq!(q.folded, "mise a jour");
        assert_eq!(q.raw_filter.as_deref(), Some("jour"));
        let q = Query::new("dit \"bonjour\"").unwrap();
        assert_eq!(q.raw_filter.as_deref(), Some("bonjour"));
        assert!(Query::new("\"\"").unwrap().raw_filter.is_none());
    }

    #[test]
    fn extracts_only_human_and_agent_text() {
        // Message utilisateur : texte nettoyé des sections injectées.
        assert_eq!(
            text_of(r#"{"type":"user","message":{"content":"<system-reminder>bruit</system-reminder>Bonjour\n le  monde"}}"#),
            Some(("user", "Bonjour le monde".into()))
        );
        assert_eq!(
            text_of(r#"{"type":"user","message":{"content":[{"type":"text","text":"a"},{"type":"tool_result","content":"secret"},{"type":"text","text":"b"}]}}"#),
            Some(("user", "a b".into()))
        );
        // Résultat d'outil seul, message meta, résumé de compaction, sous-agent : ignorés.
        assert_eq!(text_of(r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}"#), None);
        assert_eq!(text_of(r#"{"type":"user","isMeta":true,"message":{"content":"meta"}}"#), None);
        assert_eq!(text_of(r#"{"type":"user","isCompactSummary":true,"message":{"content":"résumé"}}"#), None);
        assert_eq!(text_of(r#"{"type":"user","isSidechain":true,"message":{"content":"sous-agent"}}"#), None);
        // Agent : blocs text seulement.
        assert_eq!(
            text_of(r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Voici\n\nla réponse"},{"type":"tool_use","input":{"cmd":"ls"}}]}}"#),
            Some(("assistant", "Voici la réponse".into()))
        );
        assert_eq!(text_of(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","input":{}}]}}"#), None);
        // Lignes techniques.
        assert_eq!(text_of(r#"{"type":"api-request","message":{"content":"x"}}"#), None);
        assert_eq!(text_of(r#"{"type":"file-history-snapshot"}"#), None);
    }

    #[test]
    fn builds_excerpt_around_match() {
        let ex = excerpt("Le Générateur de cartes", "generateur").unwrap();
        assert_eq!(ex, Excerpt { before: "Le ".into(), matched: "Générateur".into(), after: " de cartes".into() });

        // Contexte coupé sur un espace, avec ellipses.
        let long_before = "mot ".repeat(40);
        let long_after = " suite".repeat(40);
        let text = format!("{long_before}CIBLE{long_after}");
        let ex = excerpt(&text, "cible").unwrap();
        assert_eq!(ex.matched, "CIBLE");
        assert!(ex.before.starts_with('…') && ex.before.ends_with("mot "));
        assert!(ex.before.chars().count() <= EXCERPT_BEFORE + 1);
        assert!(ex.after.starts_with(" suite") && ex.after.ends_with('…'));
        assert!(!ex.after.contains("suit…"));

        // Repliement qui change la longueur (œ → oe) : le mot d'origine est mis en évidence.
        let ex = excerpt("Un chef-d'œuvre", "oeuvre").unwrap();
        assert_eq!(ex.matched, "œuvre");
        assert!(excerpt("rien", "absent").is_none());
    }

    #[test]
    fn scans_file_ignoring_tool_results_and_technical_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_jsonl(
            dir.path(),
            "s.jsonl",
            &[
                r#"{"type":"api-request","params":"générateur secret"}"#,
                r#"{"type":"user","uuid":"u1","message":{"content":"Parle-moi du Générateur"}}"#,
                r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"generateur dans un outil"}]}}"#,
                "pas du json generateur",
                r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"Le generateur est prêt"}]}}"#,
            ],
        );
        let q = Query::new("GÉNÉRATEUR").unwrap();
        let (count, hits) = scan_file(&p, &q, 3, &|| false);
        assert_eq!(count, 2);
        assert_eq!((hits[0].role, hits[0].line, hits[0].uuid.as_deref()), ("user", 1, Some("u1")));
        assert_eq!(hits[0].excerpt.matched, "Générateur");
        assert_eq!((hits[1].role, hits[1].line), ("assistant", 4));
        assert!(file_matches(&p, &q));
        assert!(!file_matches(&p, &Query::new("secret").unwrap()));
        assert!(!file_matches(&p, &Query::new("outil").unwrap()));
    }

    #[test]
    fn matches_across_line_breaks_and_multiple_words() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_jsonl(
            dir.path(),
            "s.jsonl",
            &[r#"{"type":"user","message":{"content":"mise\nà   jour du \"menu\""}}"#],
        );
        assert!(file_matches(&p, &Query::new("mise a jour").unwrap()));
        assert!(file_matches(&p, &Query::new("du \"menu\"").unwrap()));
        assert!(!file_matches(&p, &Query::new("mise a jours").unwrap()));
    }

    #[test]
    fn searches_projects_and_archives() {
        use crate::sessions::{SessionInfo, TitleSource};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        std::fs::create_dir_all(root.join("P1")).unwrap();
        write_jsonl(&root.join("P1"), "s1.jsonl", &[r#"{"type":"user","message":{"content":"le dragon rouge"}}"#]);
        write_jsonl(&root.join("P1"), "s2.jsonl", &[r#"{"type":"user","message":{"content":"autre chose"}}"#]);
        let archived = write_jsonl(dir.path(), "s3.jsonl", &[r#"{"type":"assistant","message":{"content":"un Dragon bleu"}}"#]);

        let info = |id: &str, updated: &str| SessionInfo {
            id: id.into(),
            project_key: "P1".into(),
            cwd: None,
            title: format!("Titre {id}"),
            title_source: TitleSource::Custom,
            first_prompt: None,
            created_at: None,
            updated_at: Some(updated.into()),
            message_count: 1,
            file_size: 0,
            modified_ms: 0,
            skipped_lines: 0,
            worktree: None,
        };
        let projects = vec![crate::scanner::Scanner::make_project(
            "P1".into(),
            Some(r"C:\P1".into()),
            vec![info("s1", "2026-01-02"), info("s2", "2026-01-03")],
        )];
        let archives = vec![ArchiveEntry {
            session_id: "s3".into(),
            project_key: "P2".into(),
            title: "Archivée".into(),
            updated_at: Some("2026-01-05".into()),
            archived_file: archived.to_string_lossy().to_string(),
            ..Default::default()
        }];
        let t = targets(&root, &projects, &archives);
        assert_eq!(t.len(), 3);

        let r = search(&t, "dragon");
        assert!(!r.cancelled && !r.truncated);
        let ids: Vec<(&str, bool)> = r.sessions.iter().map(|s| (s.session_id.as_str(), s.archived)).collect();
        // Plus récente d'abord ; l'archive est signalée.
        assert_eq!(ids, vec![("s3", true), ("s1", false)]);
        assert_eq!(r.sessions[1].title, "Titre s1");
        assert_eq!(r.sessions[1].hits[0].excerpt.after, " rouge");
        assert!(search(&t, "d").sessions.is_empty());
    }

    /// Mesure sur les vraies conversations de la machine (lecture seule) :
    /// `cargo test --release real_scan -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_scan_search() {
        let root = dirs::home_dir().unwrap().join(".claude").join("projects");
        let cache = std::env::temp_dir().join("claude-manager-test-search-cache.json");
        let projects = crate::scanner::Scanner::new(root.clone(), cache).scan();
        let t = targets(&root, &projects, &[]);
        let bytes: u64 = t.iter().filter_map(|t| std::fs::metadata(&t.file).ok()).map(|m| m.len()).sum();
        println!("{} conversations, {:.1} Mo", t.len(), bytes as f64 / 1e6);
        for q in ["claude", "générateur", "mise à jour", "zzqxwv introuvable", "fn main"] {
            let started = std::time::Instant::now();
            let r = search(&t, q);
            let hits: u32 = r.sessions.iter().map(|s| s.match_count).sum();
            println!(
                "« {q} » : {} conversations, {hits} messages, {:?}{}",
                r.sessions.len(),
                started.elapsed(),
                if r.truncated { " (coupé)" } else { "" }
            );
        }
    }
}
