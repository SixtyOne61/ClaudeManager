//! Lecture d'une conversation pour l'afficher (interface de conversation, ticket 05), en
//! LECTURE SEULE.
//!
//! Le `.jsonl` est lu par morceaux : l'interface garde la position atteinte (`offset`, en
//! octets, et `line`, numéro de la prochaine ligne) et ne redemande que la suite quand le
//! fichier change. Une ligne pas encore terminée (écriture en cours) est laissée pour la
//! prochaine lecture. À la première lecture d'un gros fichier, seule la fin est lue
//! ([`INITIAL_TAIL_BYTES`]) : les fichiers peuvent dépasser 10 Mo.
//!
//! Le format des lignes est interne à Claude Code et peut changer : lecture tolérante. Une
//! ligne illisible ou d'un type inconnu est ignorée (elle reste visible dans le terminal).
//! Les numéros de ligne sont ceux de la recherche globale (`search.rs`) : numéro de la
//! ligne physique dans le fichier, en partant de 0.

use crate::sessions::{remove_section, tag_content, NOISE_SECTIONS};
use serde::Serialize;
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Première lecture d'un gros fichier : seuls ces derniers octets sont affichés.
pub const INITIAL_TAIL_BYTES: u64 = 4 * 1024 * 1024;
/// Longueur maximale (en caractères) d'un texte envoyé à l'interface : résultat d'outil,
/// contenu d'un fichier écrit… Au-delà, il est tronqué (le terminal garde tout).
const MAX_TEXT_CHARS: usize = 20_000;
/// Nombre maximal de lignes d'une différence de code.
const MAX_DIFF_LINES: usize = 600;
/// Au-delà de ce produit (lignes avant × lignes après), pas de calcul fin de la différence :
/// toutes les anciennes lignes retirées, puis toutes les nouvelles ajoutées.
const MAX_DIFF_CELLS: usize = 250_000;

/// Une ligne d'une différence de code.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    /// `" "` (inchangée), `"-"` (retirée), `"+"` (ajoutée), `"~"` (séparation entre deux modifications).
    pub op: &'static str,
    pub text: String,
}

/// Un élément affiché de la conversation.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Entry {
    /// Message de l'utilisateur (texte nettoyé des sections ajoutées par Claude Code).
    User {
        line: u32,
        uuid: Option<String>,
        text: String,
        /// Commande `/…` (le texte est alors « /commande arguments »).
        command: bool,
    },
    /// Texte de l'agent, en Markdown.
    Assistant { line: u32, uuid: Option<String>, text: String },
    /// Action de l'agent (appel d'outil).
    Tool {
        line: u32,
        uuid: Option<String>,
        /// Identifiant de l'appel, repris par son résultat.
        id: String,
        name: String,
        /// Résumé : commande lancée, fichier lu ou modifié, motif cherché…
        title: String,
        /// Précision facultative (description de la commande…).
        detail: Option<String>,
        /// Fichier modifié (Edit, MultiEdit, Write).
        path: Option<String>,
        /// Différence de code calculée à partir de l'appel (Edit, MultiEdit, Write).
        diff: Option<Vec<DiffLine>>,
        /// La différence a été coupée.
        diff_truncated: bool,
    },
    /// Résultat d'un appel d'outil (rattaché à l'appel par `tool_use_id`).
    ToolResult {
        line: u32,
        tool_use_id: String,
        text: String,
        is_error: bool,
        /// Le texte a été tronqué ([`MAX_TEXT_CHARS`]).
        truncated: bool,
    },
    /// Remarque discrète : interruption, sortie d'une commande `/…`, conversation compactée.
    Notice { line: u32, uuid: Option<String>, text: String },
}

/// Morceau de conversation lu à partir d'une position.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// Le fichier existe (une nouvelle conversation n'en a pas avant son premier message).
    pub exists: bool,
    /// Le fichier a été relu depuis le début (plus court que la position demandée) :
    /// l'interface remplace ce qu'elle avait au lieu d'ajouter.
    pub reset: bool,
    /// Le début du fichier n'a pas été lu (gros fichier) : seule la fin est affichée.
    pub head_skipped: bool,
    pub entries: Vec<Entry>,
    /// Position à redemander la prochaine fois (début de la première ligne non lue).
    pub offset: u64,
    /// Numéro de la ligne qui commence à `offset`.
    pub line: u32,
    /// Modèle, mode de permission et consommation relevés dans la partie lue.
    pub meta: Meta,
}

/// Consommation de jetons d'une réponse de l'agent (`message.usage`).
#[derive(Serialize, Debug, Default, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub output_tokens: u64,
}

/// Modèle annoncé par Claude Code (ligne `attachment` de type `model`).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelIdentity {
    /// Identifiant, avec `[1m]` pour la variante à 1 M de contexte (« claude-opus-5[1m] »).
    pub id: String,
    /// Nom lisible (« Opus 5.5 »), s'il est donné.
    pub name: Option<String>,
}

/// Jetons produits par une réponse, repérée par l'identifiant du message : une même réponse
/// est écrite sur plusieurs lignes (une par bloc) qui répètent la même consommation.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputTokens {
    pub id: String,
    pub tokens: u64,
}

/// Informations du pied de conversation : dernières valeurs vues dans la partie lue (absentes
/// si la partie lue n'en contient pas : l'interface garde alors les précédentes).
#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    /// Modèle de la dernière réponse (`message.model`).
    pub model: Option<String>,
    /// Dernier modèle annoncé (`attachment` de type `model`).
    pub model_identity: Option<ModelIdentity>,
    /// Dernier mode de permission enregistré (`permissionMode`).
    pub permission_mode: Option<String>,
    /// Ligne où ce mode a été enregistré.
    pub permission_mode_line: Option<u32>,
    /// Consommation de la dernière réponse.
    pub usage: Option<Usage>,
    /// Jetons produits par chaque réponse lue (une entrée par message).
    pub outputs: Vec<OutputTokens>,
}

/// Trouve le fichier d'une conversation : d'abord dans le dossier du répertoire de travail
/// (`cwd` encodé comme le fait Claude Code), sinon dans n'importe quel dossier projet.
pub fn locate(root: &Path, session_id: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let name = format!("{session_id}.jsonl");
    if let Some(cwd) = cwd {
        let p = root.join(crate::sessions::encode_project_path(cwd)).join(&name);
        if p.is_file() {
            return Some(p);
        }
    }
    std::fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&name))
        .find(|p| p.is_file())
}

/// Lit la conversation à partir de `offset` (numéro de ligne `line`). Ne plante jamais :
/// une erreur de lecture arrête simplement le morceau.
pub fn read_chunk(path: &Path, offset: u64, line: u32) -> Chunk {
    let Ok(mut file) = File::open(path) else { return Chunk::default() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut chunk = Chunk { exists: true, ..Default::default() };
    let (mut pos, mut line_no) = (offset, line);
    if offset > len {
        // Fichier réécrit ou remplacé : on repart du début.
        chunk.reset = true;
        (pos, line_no) = (0, 0);
    }
    if pos == 0 && len > INITIAL_TAIL_BYTES {
        // Gros fichier : seulement la fin, en comptant les lignes sautées pour garder les
        // mêmes numéros que la recherche.
        let start = len - INITIAL_TAIL_BYTES;
        let Some((skip_to, skipped_lines)) = line_start_after(&mut file, start) else { return chunk };
        (pos, line_no) = (skip_to, skipped_lines);
        chunk.head_skipped = true;
    }
    if file.seek(SeekFrom::Start(pos)).is_err() {
        return chunk;
    }
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if buf.last() != Some(&b'\n') {
            break; // Ligne en cours d'écriture : relue la prochaine fois.
        }
        if let Ok(text) = std::str::from_utf8(&buf) {
            parse_line_meta(text, line_no, &mut chunk.entries, &mut chunk.meta);
        }
        pos += n as u64;
        line_no += 1;
    }
    chunk.offset = pos;
    chunk.line = line_no;
    chunk
}

/// Compte les lignes avant `start` et renvoie la position du début de la première ligne
/// complète à partir de `start`, avec son numéro.
fn line_start_after(file: &mut File, start: u64) -> Option<(u64, u32)> {
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut counted: u32 = 0;
    let mut remaining = start;
    let mut block = vec![0u8; 1024 * 1024];
    let mut last = b'\n';
    while remaining > 0 {
        let want = remaining.min(block.len() as u64) as usize;
        let got = file.read(&mut block[..want]).ok()?;
        if got == 0 {
            return None;
        }
        counted += block[..got].iter().filter(|&&b| b == b'\n').count() as u32;
        last = block[got - 1];
        remaining -= got as u64;
    }
    if last == b'\n' {
        return Some((start, counted));
    }
    // On est au milieu d'une ligne : on va jusqu'à sa fin.
    let mut reader = BufReader::new(&mut *file);
    let mut rest = Vec::new();
    let n = reader.read_until(b'\n', &mut rest).ok()?;
    Some((start + n as u64, counted + 1))
}

// ---------------------------------------------------------------------------
// Décodage d'une ligne
// ---------------------------------------------------------------------------

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// Ajoute à `out` les éléments affichables d'une ligne `.jsonl`. Ligne illisible, type
/// inconnu, sous-agent, ligne technique : rien n'est ajouté. (Utilisée par les tests.)
#[cfg(test)]
pub fn parse_line(text: &str, line: u32, out: &mut Vec<Entry>) {
    parse_line_meta(text, line, out, &mut Meta::default());
}

/// Comme [`parse_line`], et relève en plus dans `meta` le modèle, le mode de permission et
/// la consommation de jetons.
pub fn parse_line_meta(text: &str, line: u32, out: &mut Vec<Entry>, meta: &mut Meta) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    // Repérage rapide avant décodage : lignes de message, ou lignes portant le modèle / le mode.
    let message = text.contains("\"user\"") || text.contains("\"assistant\"");
    let info = text.contains("\"permissionMode\"") || text.contains("\"identity\"");
    if !message && !info {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(text) else { return };
    let flag = |k: &str| v.get(k).and_then(Value::as_bool) == Some(true);
    if flag("isSidechain") {
        return;
    }
    read_meta(&v, line, meta);
    let uuid = str_at(&v, "uuid").map(str::to_string);
    let Some(content) = v.pointer("/message/content") else { return };
    match str_at(&v, "type") {
        Some("user") => {
            if flag("isCompactSummary") {
                out.push(Entry::Notice { line, uuid, text: "Conversation compactée".into() });
                return;
            }
            if flag("isMeta") {
                return;
            }
            parse_user(content, line, uuid, out);
        }
        Some("assistant") => parse_assistant(content, line, uuid, out),
        _ => {}
    }
}

/// Modèle, mode de permission et consommation d'une ligne (sous-agents exclus en amont).
///
/// - `permissionMode` : sur les messages de l'utilisateur (mode au moment de l'envoi) et sur
///   les lignes `{"type":"permission-mode"}` (écrites avec l'état de la session) ;
/// - `message.model` et `message.usage` : sur les réponses de l'agent (`<synthetic>` : message
///   d'erreur fabriqué par Claude Code, ignoré) ;
/// - `attachment` de type `model` : modèle annoncé, avec son nom lisible.
fn read_meta(v: &Value, line: u32, meta: &mut Meta) {
    match str_at(v, "type") {
        Some("user") | Some("permission-mode") => {
            if let Some(mode) = str_at(v, "permissionMode").filter(|m| !m.is_empty()) {
                meta.permission_mode = Some(mode.to_string());
                meta.permission_mode_line = Some(line);
            }
        }
        Some("assistant") => {
            let Some(msg) = v.get("message") else { return };
            let Some(model) = str_at(msg, "model").filter(|m| !m.is_empty() && !m.starts_with('<')) else { return };
            meta.model = Some(model.to_string());
            let Some(u) = msg.get("usage") else { return };
            let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
            let usage = Usage {
                input_tokens: n("input_tokens"),
                cache_creation_input_tokens: n("cache_creation_input_tokens"),
                cache_read_input_tokens: n("cache_read_input_tokens"),
                output_tokens: n("output_tokens"),
            };
            if let Some(id) = str_at(msg, "id") {
                // Les lignes d'une même réponse se suivent : seule la dernière entrée est à voir.
                match meta.outputs.last_mut() {
                    Some(o) if o.id == id => o.tokens = usage.output_tokens,
                    _ => meta.outputs.push(OutputTokens { id: id.to_string(), tokens: usage.output_tokens }),
                }
            }
            meta.usage = Some(usage);
        }
        Some("attachment") => {
            let Some(a) = v.get("attachment").filter(|a| str_at(a, "type") == Some("model")) else { return };
            let Some(id) = a.pointer("/identity/modelId").and_then(Value::as_str).filter(|m| !m.is_empty()) else { return };
            let name = a.pointer("/identity/marketingName").and_then(Value::as_str).map(str::to_string);
            meta.model_identity = Some(ModelIdentity { id: id.to_string(), name });
        }
        _ => {}
    }
}

fn parse_user(content: &Value, line: u32, uuid: Option<String>, out: &mut Vec<Entry>) {
    let mut texts: Vec<&str> = Vec::new();
    match content {
        Value::String(s) => texts.push(s),
        Value::Array(blocks) => {
            for b in blocks {
                match str_at(b, "type") {
                    Some("text") => texts.extend(str_at(b, "text")),
                    Some("tool_result") => {
                        let (text, truncated) = truncate(&result_text(b.get("content")));
                        out.push(Entry::ToolResult {
                            line,
                            tool_use_id: str_at(b, "tool_use_id").unwrap_or_default().to_string(),
                            text,
                            is_error: b.get("is_error").and_then(Value::as_bool) == Some(true),
                            truncated,
                        });
                    }
                    _ => {} // image, document… : non affichés
                }
            }
        }
        _ => {}
    }
    if texts.is_empty() {
        return;
    }
    let raw = texts.join("\n");
    if let Some(entry) = user_entry(&raw, line, uuid) {
        out.push(entry);
    }
}

/// Message utilisateur à afficher, à partir de son texte brut.
fn user_entry(raw: &str, line: u32, uuid: Option<String>) -> Option<Entry> {
    // Commande `/…` : "<command-name>/review</command-name><command-args>x</command-args>".
    if let Some(name) = tag_content(raw, "command-name") {
        let args = tag_content(raw, "command-args").unwrap_or("");
        let text = format!("{name} {args}").trim().to_string();
        return (!text.is_empty()).then_some(Entry::User { line, uuid, text, command: true });
    }
    // Sortie d'une commande `/…` (affichée discrètement, sans les codes de couleur).
    if let Some(stdout) = tag_content(raw, "local-command-stdout") {
        let text = strip_ansi(stdout).trim().to_string();
        let (text, _) = truncate(&text);
        return (!text.is_empty()).then_some(Entry::Notice { line, uuid, text });
    }
    let mut text = raw.to_string();
    for tag in NOISE_SECTIONS.iter().copied().chain(["task-notification", "command-message"]) {
        text = remove_section(&text, tag);
    }
    // Texte collé (c'est ainsi que l'app envoie les messages) : Claude Code l'encadre de
    // `<pasted_content id="…">…</pasted_content id="…">` ; on ne garde que le contenu.
    let text = unwrap_tag(&text, "pasted_content");
    let text = text.trim();
    if text.is_empty() || text.starts_with("Caveat:") {
        return None;
    }
    if text.starts_with("[Request interrupted") {
        return Some(Entry::Notice { line, uuid, text: "Interrompu par l'utilisateur".into() });
    }
    Some(Entry::User { line, uuid, text: text.to_string(), command: false })
}

/// Retire les balises ouvrantes et fermantes `<tag …>` / `</tag …>` en gardant leur contenu.
fn unwrap_tag(text: &str, tag: &str) -> String {
    let (open, close) = (format!("<{tag}"), format!("</{tag}"));
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let next = [rest.find(&open), rest.find(&close)].into_iter().flatten().min();
        let Some(start) = next else { break };
        let len = if rest[start..].starts_with(&close) { close.len() } else { open.len() };
        // Vraie balise : le nom est suivi de `>` ou d'un espace (attributs), puis d'un `>`.
        let after = &rest[start + len..];
        let end = match after.chars().next() {
            Some('>') => Some(0),
            Some(c) if c.is_whitespace() => after.find('>').filter(|&e| !after[..e].contains('\n')),
            _ => None,
        };
        match end {
            Some(e) => {
                out.push_str(&rest[..start]);
                rest = &after[e + 1..];
            }
            None => {
                out.push_str(&rest[..start + len]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_assistant(content: &Value, line: u32, uuid: Option<String>, out: &mut Vec<Entry>) {
    let blocks: Vec<Value> = match content {
        Value::String(s) => vec![serde_json::json!({ "type": "text", "text": s })],
        Value::Array(b) => b.clone(),
        _ => return,
    };
    for b in &blocks {
        match str_at(b, "type") {
            Some("text") => {
                let text = str_at(b, "text").unwrap_or_default().trim();
                if !text.is_empty() {
                    out.push(Entry::Assistant { line, uuid: uuid.clone(), text: text.to_string() });
                }
            }
            Some("tool_use") => {
                let name = str_at(b, "name").unwrap_or("?").to_string();
                let input = b.get("input").cloned().unwrap_or(Value::Null);
                out.push(tool_entry(line, uuid.clone(), str_at(b, "id").unwrap_or_default(), name, &input));
            }
            _ => {} // thinking, server_tool_use… : non affichés
        }
    }
}

/// Carte d'une action de l'agent, d'après le nom de l'outil et ses paramètres.
fn tool_entry(line: u32, uuid: Option<String>, id: &str, name: String, input: &Value) -> Entry {
    let s = |k: &str| str_at(input, k).map(str::to_string);
    let path = s("file_path").or_else(|| s("notebook_path"));
    let mut detail = None;
    let mut diff = None;
    let title = match name.as_str() {
        "Bash" | "PowerShell" => {
            detail = s("description");
            s("command").unwrap_or_default()
        }
        "Read" | "NotebookEdit" | "NotebookRead" => path.clone().unwrap_or_default(),
        "Edit" => {
            diff = Some(line_diff(&s("old_string").unwrap_or_default(), &s("new_string").unwrap_or_default()));
            path.clone().unwrap_or_default()
        }
        "MultiEdit" => {
            let mut lines = Vec::new();
            for (i, e) in input.get("edits").and_then(Value::as_array).into_iter().flatten().enumerate() {
                if i > 0 {
                    lines.push(DiffLine { op: "~", text: String::new() });
                }
                lines.extend(line_diff(str_at(e, "old_string").unwrap_or_default(), str_at(e, "new_string").unwrap_or_default()));
            }
            diff = Some(lines);
            path.clone().unwrap_or_default()
        }
        "Write" => {
            let (content, _) = truncate(&s("content").unwrap_or_default());
            diff = Some(content.lines().map(|l| DiffLine { op: "+", text: l.to_string() }).collect());
            path.clone().unwrap_or_default()
        }
        "Grep" | "Glob" => {
            detail = s("path");
            s("pattern").unwrap_or_default()
        }
        "WebFetch" => s("url").unwrap_or_default(),
        "WebSearch" => s("query").unwrap_or_default(),
        "Task" | "Agent" => s("description").unwrap_or_default(),
        "Skill" => s("skill").unwrap_or_default(),
        "TodoWrite" => {
            let n = input.get("todos").and_then(Value::as_array).map_or(0, Vec::len);
            format!("{n} tâche(s)")
        }
        _ => compact_json(input),
    };
    let (diff, diff_truncated) = match diff {
        Some(mut d) if d.len() > MAX_DIFF_LINES => {
            d.truncate(MAX_DIFF_LINES);
            (Some(d), true)
        }
        d => (d, false),
    };
    let path = path.filter(|_| diff.is_some());
    Entry::Tool { line, uuid, id: id.to_string(), name, title, detail, path, diff, diff_truncated }
}

/// Paramètres d'un outil inconnu, sur une ligne, raccourcis.
fn compact_json(v: &Value) -> String {
    if v.is_null() || v.as_object().is_some_and(|o| o.is_empty()) {
        return String::new();
    }
    let s = v.to_string();
    if s.chars().count() > 300 {
        format!("{}…", s.chars().take(300).collect::<String>())
    } else {
        s
    }
}

/// Texte d'un résultat d'outil : chaîne, ou blocs `text` (une image est signalée).
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| match str_at(b, "type") {
                Some("text") => str_at(b, "text").map(str::to_string),
                Some("image") => Some("[image]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Coupe un texte trop long ([`MAX_TEXT_CHARS`]). Renvoie aussi s'il a été coupé.
fn truncate(s: &str) -> (String, bool) {
    match s.char_indices().nth(MAX_TEXT_CHARS) {
        Some((i, _)) => (s[..i].to_string(), true),
        None => (s.to_string(), false),
    }
}

/// Retire les séquences de couleur du terminal (`ESC[…m`).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for d in chars.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------------------
// Différence de code
// ---------------------------------------------------------------------------

/// Différence ligne à ligne entre deux textes (plus longue sous-suite commune).
pub fn line_diff(old: &str, new: &str) -> Vec<DiffLine> {
    let a: Vec<&str> = if old.is_empty() { Vec::new() } else { old.lines().collect() };
    let b: Vec<&str> = if new.is_empty() { Vec::new() } else { new.lines().collect() };
    let line = |op, t: &str| DiffLine { op, text: t.to_string() };
    if a.len().saturating_mul(b.len()) > MAX_DIFF_CELLS {
        return a.iter().map(|t| line("-", t)).chain(b.iter().map(|t| line("+", t))).collect();
    }
    // lcs[i][j] : longueur de la plus longue sous-suite commune de a[i..] et b[j..].
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::with_capacity(n + m);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            out.push(line(" ", a[i]));
            i += 1;
            j += 1;
        } else if i < n && (j == m || lcs[i + 1][j] >= lcs[i][j + 1]) {
            // Les lignes retirées avant les lignes ajoutées.
            out.push(line("-", a[i]));
            i += 1;
        } else {
            out.push(line("+", b[j]));
            j += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn texte_colle_sans_balises() {
        let raw = "<pasted_content id=\"2a56\">
Bonjour
<b>gras</b> et <pasted_contentx>
</pasted_content id=\"2a56\">";
        match user_entry(raw, 1, None) {
            Some(Entry::User { text, .. }) => assert_eq!(text, "Bonjour
<b>gras</b> et <pasted_contentx>"),
            _ => panic!("message attendu"),
        }
        assert_eq!(unwrap_tag("a <pasted_content>b</pasted_content> c", "pasted_content"), "a b c");
    }

    // Formes de lignes relevées dans de vrais fichiers de Claude Code (contenu inventé).
    const USER: &str = r#"{"parentUuid":null,"isSidechain":false,"promptId":"p1","type":"user","message":{"role":"user","content":"Corrige le menu\nsur mobile"},"uuid":"u1","timestamp":"2026-11-20T10:00:00.000Z","userType":"external","entrypoint":"cli","cwd":"C:\\Projets\\Site","sessionId":"s1","version":"2.1.0","gitBranch":"main"}"#;
    const COMMAND: &str = r#"{"type":"user","message":{"role":"user","content":"<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>main</command-args>"},"uuid":"u2"}"#;
    const META: &str = r#"{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill"}]},"uuid":"u3"}"#;
    const THINKING: &str = r#"{"parentUuid":"u1","isSidechain":false,"message":{"model":"claude-opus","id":"msg_1","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"…","signature":"x"}]},"requestId":"r1","type":"assistant","uuid":"a0"}"#;
    const TEXT: &str = r#"{"parentUuid":"a0","isSidechain":false,"message":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Je regarde **le menu**."}]},"type":"assistant","uuid":"a1"}"#;
    const BASH: &str = r#"{"message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"git status","description":"État du dépôt"},"caller":{"type":"direct"}}]},"type":"assistant","uuid":"a2"}"#;
    const BASH_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"On branch main\nnothing to commit","is_error":false}]},"uuid":"u4","toolUseResult":{"stdout":"On branch main","stderr":"","interrupted":false}}"#;
    const EDIT: &str = r#"{"message":{"id":"msg_2","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"replace_all":false,"file_path":"C:\\Projets\\Site\\menu.js","old_string":"a\nb\nc","new_string":"a\nB\nc"}}]},"type":"assistant","uuid":"a3"}"#;
    const ERROR_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":[{"type":"text","text":"Exit code 2"}],"is_error":true,"tool_use_id":"toolu_1"}]},"uuid":"u5"}"#;
    const INTERRUPTED: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"uuid":"u6"}"#;
    const SIDECHAIN: &str = r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"sous-agent"}]},"uuid":"x"}"#;
    const OTHER: [&str; 4] = [
        r#"{"type":"file-history-snapshot","messageId":"m","snapshot":{},"isSnapshotUpdate":false}"#,
        r#"{"type":"system","subtype":"stop_hook_summary","hookCount":1,"uuid":"s"}"#,
        r#"{"type":"custom-title","customTitle":"Menu","sessionId":"s1"}"#,
        r#"{"type":"attachment","attachment":{"type":"user"},"uuid":"t"}"#,
    ];

    fn parse(lines: &[&str]) -> Vec<Entry> {
        let mut out = Vec::new();
        for (i, l) in lines.iter().enumerate() {
            parse_line(l, i as u32, &mut out);
        }
        out
    }

    #[test]
    fn parses_messages_and_tools() {
        let e = parse(&[USER, COMMAND, META, THINKING, TEXT, BASH, BASH_RESULT, EDIT, ERROR_RESULT, INTERRUPTED, SIDECHAIN]);
        assert_eq!(
            e[0],
            Entry::User { line: 0, uuid: Some("u1".into()), text: "Corrige le menu\nsur mobile".into(), command: false }
        );
        assert_eq!(e[1], Entry::User { line: 1, uuid: Some("u2".into()), text: "/review main".into(), command: true });
        assert_eq!(e[2], Entry::Assistant { line: 4, uuid: Some("a1".into()), text: "Je regarde **le menu**.".into() });
        let Entry::Tool { name, title, detail, diff, .. } = &e[3] else { panic!("{:?}", e[3]) };
        assert_eq!((name.as_str(), title.as_str(), detail.as_deref(), diff), ("Bash", "git status", Some("État du dépôt"), &None));
        let Entry::ToolResult { tool_use_id, text, is_error, line, .. } = &e[4] else { panic!() };
        assert_eq!((tool_use_id.as_str(), text.as_str(), *is_error, *line), ("toolu_1", "On branch main\nnothing to commit", false, 6));
        let Entry::Tool { name, path, diff: Some(diff), .. } = &e[5] else { panic!() };
        assert_eq!((name.as_str(), path.as_deref()), ("Edit", Some(r"C:\Projets\Site\menu.js")));
        let ops: Vec<_> = diff.iter().map(|d| format!("{}{}", d.op, d.text)).collect();
        assert_eq!(ops, [" a", "-b", "+B", " c"]);
        let Entry::ToolResult { text, is_error, .. } = &e[6] else { panic!() };
        assert_eq!((text.as_str(), *is_error), ("Exit code 2", true));
        assert_eq!(e[7], Entry::Notice { line: 9, uuid: Some("u6".into()), text: "Interrompu par l'utilisateur".into() });
        assert_eq!(e.len(), 8);
    }

    #[test]
    fn ignores_unknown_technical_and_broken_lines() {
        let mut lines = OTHER.to_vec();
        lines.extend([r#"{"type":"user","message":{"content":"#, "pas du json", "", r#"{"type":"nouveau-type","user":"x"}"#]);
        assert!(parse(&lines).is_empty());
    }

    #[test]
    fn cleans_injected_sections() {
        let line = r#"{"type":"user","message":{"content":"<system-reminder>caché</system-reminder>\nVoici ma question"},"uuid":"u"}"#;
        let notif = r#"{"type":"user","message":{"content":"<task-notification>\n<task-id>1</task-id>\n</task-notification>"},"uuid":"u"}"#;
        let stdout = r#"{"type":"user","message":{"content":"<local-command-stdout>\u001b[1mModèle\u001b[22m : opus</local-command-stdout>"},"uuid":"u"}"#;
        let e = parse(&[line, notif, stdout]);
        assert_eq!(e.len(), 2);
        assert!(matches!(&e[0], Entry::User { text, .. } if text == "Voici ma question"));
        assert!(matches!(&e[1], Entry::Notice { text, .. } if text == "Modèle : opus"));
    }

    #[test]
    fn write_and_multiedit_diffs() {
        let write = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Write","input":{"file_path":"x.txt","content":"un\ndeux"}}]}}"#;
        let multi = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"MultiEdit","input":{"file_path":"y.txt","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":""}]}}]}}"#;
        let e = parse(&[write, multi]);
        let Entry::Tool { diff: Some(d), .. } = &e[0] else { panic!() };
        assert_eq!(d.iter().map(|l| l.op).collect::<String>(), "++");
        let Entry::Tool { diff: Some(d), .. } = &e[1] else { panic!() };
        assert_eq!(d.iter().map(|l| l.op).collect::<String>(), "-+~-");
    }

    #[test]
    fn reads_model_mode_and_usage() {
        let lines = [
            r#"{"type":"attachment","attachment":{"type":"model","identity":{"modelId":"claude-opus-5-5[1m]","marketingName":"Opus 5.5 (1M context)","knowledgeCutoff":"June 2026"},"text":"…"},"uuid":"m"}"#,
            r#"{"type":"user","permissionMode":"default","message":{"role":"user","content":"Salut"},"uuid":"u1"}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":""}],"usage":{"input_tokens":3,"cache_creation_input_tokens":100,"cache_read_input_tokens":5000,"output_tokens":40}},"uuid":"a1"}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_1","role":"assistant","content":[{"type":"text","text":"Bonjour"}],"usage":{"input_tokens":3,"cache_creation_input_tokens":100,"cache_read_input_tokens":5000,"output_tokens":40}},"uuid":"a2"}"#,
            r#"{"type":"user","permissionMode":"acceptEdits","message":{"role":"user","content":"Encore"},"uuid":"u2"}"#,
            r#"{"type":"assistant","message":{"model":"<synthetic>","id":"msg_x","role":"assistant","content":[{"type":"text","text":"API Error"}],"usage":{"input_tokens":0,"output_tokens":0}},"uuid":"ax"}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"model":"claude-haiku-5-5","id":"msg_s","content":[],"usage":{"input_tokens":9,"output_tokens":9}},"uuid":"s"}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_2","role":"assistant","content":[{"type":"text","text":"Voilà"}],"usage":{"input_tokens":1,"cache_creation_input_tokens":50,"cache_read_input_tokens":5100,"output_tokens":12}},"uuid":"a3"}"#,
            r#"{"type":"permission-mode","permissionMode":"plan","sessionId":"s1"}"#,
        ];
        let (mut out, mut meta) = (Vec::new(), Meta::default());
        for (i, l) in lines.iter().enumerate() {
            parse_line_meta(l, i as u32, &mut out, &mut meta);
        }
        assert_eq!(meta.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(
            meta.model_identity,
            Some(ModelIdentity { id: "claude-opus-5-5[1m]".into(), name: Some("Opus 5.5 (1M context)".into()) })
        );
        assert_eq!((meta.permission_mode.as_deref(), meta.permission_mode_line), (Some("plan"), Some(8)));
        assert_eq!(
            meta.usage,
            Some(Usage { input_tokens: 1, cache_creation_input_tokens: 50, cache_read_input_tokens: 5100, output_tokens: 12 })
        );
        let outputs: Vec<_> = meta.outputs.iter().map(|o| (o.id.as_str(), o.tokens)).collect();
        assert_eq!(outputs, [("msg_1", 40), ("msg_2", 12)]);
        // Les éléments affichés ne changent pas.
        assert_eq!(out.len(), 5);
        // Une ligne sans ces informations laisse tout absent.
        let mut empty = Meta::default();
        parse_line_meta(USER, 0, &mut Vec::new(), &mut empty);
        assert_eq!(empty, Meta::default());
    }

    #[test]
    fn diff_keeps_common_lines() {
        let d = line_diff("a\nb\nc\nd", "a\nc\nd\ne");
        let s: Vec<_> = d.iter().map(|l| format!("{}{}", l.op, l.text)).collect();
        assert_eq!(s, [" a", "-b", " c", " d", "+e"]);
    }

    #[test]
    fn reads_incrementally_and_waits_for_complete_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        write!(f, "{USER}\n{}\n{TEXT}\n{}", OTHER[0], &BASH[..20]).unwrap();
        f.flush().unwrap();
        let c = read_chunk(&path, 0, 0);
        assert!(c.exists && !c.reset && !c.head_skipped);
        assert_eq!(c.entries.len(), 2);
        assert_eq!(c.line, 3);
        // La fin de la ligne en cours d'écriture arrive : elle est lue la fois suivante.
        write!(f, "{}\n{BASH_RESULT}\n", &BASH[20..]).unwrap();
        f.flush().unwrap();
        let c2 = read_chunk(&path, c.offset, c.line);
        assert_eq!(c2.entries.len(), 2);
        assert!(matches!(&c2.entries[0], Entry::Tool { line: 3, .. }));
        assert!(matches!(&c2.entries[1], Entry::ToolResult { line: 4, .. }));
        assert_eq!(c2.offset, std::fs::metadata(&path).unwrap().len());
        // Rien de neuf : morceau vide, même position.
        let c3 = read_chunk(&path, c2.offset, c2.line);
        assert!(c3.entries.is_empty() && c3.offset == c2.offset);
        // Fichier remplacé par un plus court : relu depuis le début.
        std::fs::write(&path, format!("{USER}\n")).unwrap();
        let c4 = read_chunk(&path, c2.offset, c2.line);
        assert!(c4.reset);
        assert_eq!((c4.entries.len(), c4.line), (1, 1));
        // Fichier absent (nouvelle conversation pas encore écrite).
        assert!(!read_chunk(&dir.path().join("absent.jsonl"), 0, 0).exists);
    }

    #[test]
    fn large_file_reads_only_the_tail_with_true_line_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        let mut f = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
        let filler = OTHER[1];
        let count = (INITIAL_TAIL_BYTES as usize * 2) / filler.len();
        for _ in 0..count {
            writeln!(f, "{filler}").unwrap();
        }
        writeln!(f, "{USER}").unwrap();
        drop(f);
        let c = read_chunk(&path, 0, 0);
        assert!(c.head_skipped);
        assert_eq!(c.entries.len(), 1);
        assert!(matches!(&c.entries[0], Entry::User { line, .. } if *line as usize == count));
        assert_eq!(c.line as usize, count + 1);
    }

    #[test]
    fn locates_file_by_cwd_or_anywhere() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("C--Projets-Site");
        let b = dir.path().join("autre");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("s1.jsonl"), "").unwrap();
        std::fs::write(b.join("s2.jsonl"), "").unwrap();
        assert_eq!(locate(dir.path(), "s1", Some(r"C:\Projets\Site")), Some(a.join("s1.jsonl")));
        assert_eq!(locate(dir.path(), "s2", Some(r"C:\Projets\Site")), Some(b.join("s2.jsonl")));
        assert_eq!(locate(dir.path(), "s3", None), None);
    }

    /// Lecture de vrais fichiers (lancé à la main : `cargo test real_ -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn real_conversation_read() {
        let root = dirs::home_dir().unwrap().join(".claude").join("projects");
        let mut files: Vec<_> = std::fs::read_dir(&root).unwrap().flatten()
            .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
            .collect();
        files.sort_by_key(|p| std::cmp::Reverse(std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)));
        for p in files.iter().take(5) {
            let t = std::time::Instant::now();
            let c = read_chunk(p, 0, 0);
            let kinds = c.entries.iter().fold(std::collections::BTreeMap::new(), |mut m, e| {
                let k = match e { Entry::User { .. } => "user", Entry::Assistant { .. } => "assistant", Entry::Tool { .. } => "tool", Entry::ToolResult { .. } => "result", Entry::Notice { .. } => "notice" };
                *m.entry(k).or_insert(0) += 1;
                m
            });
            println!("{} octets, {:?}, tête sautée {}, {:?}", std::fs::metadata(p).unwrap().len(), t.elapsed(), c.head_skipped, kinds);
        }
    }
}
