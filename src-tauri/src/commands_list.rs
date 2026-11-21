//! Liste des commandes `/…` proposées dans la zone de saisie (menu « slash »).
//!
//! Sources, d'après la documentation de Claude Code (skills, commands, plugins) :
//! - commandes intégrées : liste fixe ci-dessous, décrite en français ;
//! - skills personnels `~/.claude/skills/<nom>/SKILL.md` et anciennes commandes
//!   `~/.claude/commands/**/*.md` (`$CLAUDE_CONFIG_DIR` à la place de `~/.claude`) ;
//! - skills et commandes du projet : `.claude/skills` et `.claude/commands` du dossier de la
//!   conversation et de ses parents jusqu'à la racine du dépôt git ;
//! - plugins installés (`plugins/installed_plugins.json`) et activés (`enabledPlugins` des
//!   réglages utilisateur puis projet), nommés `plugin:nom` ; plugins rangés dans un dossier
//!   de skills (`.claude-plugin/plugin.json`) ;
//! - le `.jsonl` de la conversation : ses lignes `"attachment":{"type":"skill_listing"…}`
//!   donnent les skills que Claude Code a vraiment chargés (y compris ceux synchronisés
//!   depuis claude.ai, introuvables sur disque). Elles complètent la découverte sur disque.
//!
//! Lecture seule : rien n'est jamais écrit dans ces dossiers.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Longueur maximale d'une description (une ligne dans le menu).
const MAX_DESCRIPTION: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// Commande ou skill fourni avec Claude Code.
    Builtin,
    /// `~/.claude/skills` ou `~/.claude/commands`.
    User,
    /// `.claude/skills` ou `.claude/commands` du projet.
    Project,
    /// Skill ou commande d'un plugin (`plugin:nom`).
    Plugin,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashEntry {
    /// Sans la barre oblique : `compact`, `mon-plugin:revue`.
    pub name: String,
    pub description: String,
    pub source: Source,
    /// Indication d'arguments (`[fichier]`), si connue.
    pub argument_hint: Option<String>,
}

// ---------------------------------------------------------------------------
// Commandes intégrées
// ---------------------------------------------------------------------------

/// Principales commandes intégrées (noms vérifiés dans la référence des commandes).
const BUILTINS: &[(&str, &str, Option<&str>)] = &[
    ("add-dir", "Ajouter un dossier de travail à la session", Some("<chemin>")),
    ("agents", "Gérer les sous-agents", None),
    ("batch", "Orchestrer de gros changements en parallèle dans le code", Some("<instruction>")),
    ("branch", "Créer une branche de la conversation à ce point", Some("[nom]")),
    ("btw", "Poser une question annexe sans l'ajouter à la conversation", Some("[question]")),
    ("cd", "Déplacer la session dans un autre dossier", Some("<chemin>")),
    ("clear", "Nouvelle conversation, contexte vidé", Some("[nom]")),
    ("code-review", "Relire les changements en cours ou une PR", Some("[niveau] [pr|branche|chemin]")),
    ("compact", "Résumer la conversation pour libérer du contexte", Some("[instructions]")),
    ("config", "Ouvrir les réglages", Some("[clé=valeur]")),
    ("context", "Visualiser l'occupation du contexte", None),
    ("copy", "Copier la dernière réponse dans le presse-papiers", Some("[N]")),
    ("cost", "Alias de /usage", None),
    ("debug", "Activer les journaux de débogage et diagnostiquer", Some("[description]")),
    ("diff", "Voir les changements du dossier de travail", None),
    ("doctor", "Vérifier l'installation et proposer des corrections", None),
    ("effort", "Régler le niveau d'effort", Some("[niveau]")),
    ("exit", "Quitter Claude Code", None),
    ("export", "Exporter la conversation en texte", Some("[fichier]")),
    ("fast", "Activer ou couper le mode rapide", Some("[on|off]")),
    ("fewer-permission-prompts", "Ajouter une liste d'autorisations d'après l'historique", None),
    ("help", "Afficher l'aide et les commandes disponibles", None),
    ("hooks", "Voir la configuration des hooks", None),
    ("init", "Créer un guide CLAUDE.md pour le projet", None),
    ("login", "Se connecter à son compte Anthropic", None),
    ("logout", "Se déconnecter de son compte Anthropic", None),
    ("loop", "Relancer une consigne à intervalle régulier", Some("[intervalle] [consigne]")),
    ("mcp", "Gérer les serveurs MCP", None),
    ("memory", "Modifier les fichiers CLAUDE.md et la mémoire", None),
    ("model", "Changer de modèle", Some("[modèle]")),
    ("output-style", "Changer de style de réponse", Some("[style]")),
    ("permissions", "Gérer les règles de permission des outils", None),
    ("plan", "Passer en mode plan", Some("[description]")),
    ("plugin", "Gérer les plugins", Some("[sous-commande]")),
    ("reload-plugins", "Recharger les plugins", None),
    ("reload-skills", "Recharger les skills et commandes du disque", None),
    ("rename", "Renommer la session", Some("[nom]")),
    ("resume", "Reprendre une conversation", Some("[session]")),
    ("review", "Alias de /code-review", Some("[pr|branche|chemin]")),
    ("rewind", "Revenir à un point antérieur (conversation ou code)", None),
    ("run", "Lancer l'application pour voir un changement fonctionner", None),
    ("security-review", "Revue de sécurité des changements de la branche", None),
    ("simplify", "Relire le code modifié et le simplifier", Some("[cible]")),
    ("skills", "Lister les skills disponibles", None),
    ("status", "Version, modèle, compte et connexion", None),
    ("statusline", "Configurer la ligne d'état", None),
    ("tasks", "Voir les tâches en arrière-plan", None),
    ("theme", "Changer le thème de couleurs", None),
    ("update-config", "Modifier les réglages de Claude Code en le décrivant", Some("[demande]")),
    ("usage", "Coût de la session et limites d'utilisation", None),
    ("verify", "Construire et lancer l'application pour vérifier un changement", None),
];

pub fn builtins() -> Vec<SlashEntry> {
    BUILTINS
        .iter()
        .map(|(name, desc, hint)| SlashEntry {
            name: name.to_string(),
            description: desc.to_string(),
            source: Source::Builtin,
            argument_hint: hint.map(str::to_string),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// En-tête YAML (frontmatter)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    /// `user-invocable: false` : caché du menu `/`.
    pub user_invocable: bool,
    /// Première ligne non vide du corps (description par défaut).
    pub first_line: Option<String>,
}

/// Enlève les guillemets d'une valeur YAML simple.
fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
        let inner = &v[1..v.len() - 1];
        return if v.starts_with('\'') { inner.replace("''", "'") } else { inner.replace("\\\"", "\"").replace("\\n", " ") };
    }
    v.to_string()
}

/// Lit l'en-tête `---` … `---` d'un SKILL.md ou d'une commande. Sous-ensemble de YAML
/// suffisant pour ces fichiers : `clé: valeur`, valeurs entre guillemets, blocs `>` / `|`
/// et valeurs continuées sur les lignes indentées suivantes. Ne plante jamais.
pub fn parse_frontmatter(text: &str) -> Frontmatter {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut fm = Frontmatter { user_invocable: true, ..Default::default() };
    let mut lines = text.lines();
    let mut body_start = 0usize;
    let mut fields: Vec<(String, String)> = Vec::new();
    if lines.next().map(str::trim_end) == Some("---") {
        let all: Vec<&str> = text.lines().collect();
        let mut i = 1;
        let mut closed = false;
        while i < all.len() {
            let line = all[i];
            if line.trim_end() == "---" {
                closed = true;
                i += 1;
                break;
            }
            let indented = line.starts_with(' ') || line.starts_with('\t');
            if !indented {
                if let Some((k, v)) = line.split_once(':') {
                    fields.push((k.trim().to_string(), v.trim().to_string()));
                }
            } else if let Some(last) = fields.last_mut() {
                // Suite de la valeur précédente (bloc ou ligne repliée).
                let t = line.trim();
                if !t.is_empty() && !t.starts_with('-') {
                    if last.1 == ">" || last.1 == "|" || last.1 == ">-" || last.1 == "|-" {
                        last.1 = t.to_string();
                    } else {
                        last.1.push(' ');
                        last.1.push_str(t);
                    }
                }
            }
            i += 1;
        }
        if closed {
            body_start = i;
        } else {
            fields.clear(); // pas d'en-tête fermé : tout est du corps
        }
    }
    for (k, v) in fields {
        let v = unquote(&v);
        match k.as_str() {
            "name" if !v.is_empty() => fm.name = Some(v),
            "description" if !v.is_empty() && v != ">" && v != "|" => fm.description = Some(v),
            "argument-hint" if !v.is_empty() => fm.argument_hint = Some(v),
            "user-invocable" => fm.user_invocable = !v.eq_ignore_ascii_case("false"),
            _ => {}
        }
    }
    fm.first_line = text
        .lines()
        .skip(body_start)
        .map(|l| l.trim().trim_start_matches('#').trim())
        .find(|l| !l.is_empty())
        .map(str::to_string);
    fm
}

/// Description sur une ligne, raccourcie.
pub fn one_line(s: &str) -> String {
    let s: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > MAX_DESCRIPTION {
        let mut t: String = s.chars().take(MAX_DESCRIPTION - 1).collect();
        t.push('…');
        t
    } else {
        s
    }
}

fn entry_from(fm: &Frontmatter, name: String, source: Source) -> SlashEntry {
    let desc = fm.description.as_deref().or(fm.first_line.as_deref()).unwrap_or("");
    SlashEntry { name, description: one_line(desc), source, argument_hint: fm.argument_hint.clone() }
}

/// Nom d'un composant de plugin : `plugin:nom`, sans doubler un préfixe déjà présent.
fn with_prefix(prefix: Option<&str>, name: &str) -> String {
    match prefix {
        Some(p) if !name.starts_with(&format!("{p}:")) => format!("{p}:{name}"),
        _ => name.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Découverte sur disque
// ---------------------------------------------------------------------------

/// Un skill : `<dossier>/SKILL.md`. Nom : `name` de l'en-tête, sinon le nom du dossier.
fn read_skill(dir: &Path, source: Source, prefix: Option<&str>) -> Option<SlashEntry> {
    let text = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let fm = parse_frontmatter(&text);
    if !fm.user_invocable {
        return None;
    }
    let base = fm.name.clone().unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    if base.is_empty() {
        return None;
    }
    Some(entry_from(&fm, with_prefix(prefix, &base), source))
}

/// Sous-dossiers d'un dossier de skills, triés (liens symboliques suivis).
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    v.sort();
    v
}

/// Skills d'un dossier `skills/`. Le dossier `synced` (réservé aux skills de claude.ai) et
/// les plugins rangés là (`.claude-plugin/plugin.json`) sont renvoyés à part.
pub fn scan_skills_dir(dir: &Path, source: Source, prefix: Option<&str>, plugin_dirs: &mut Vec<PathBuf>) -> Vec<SlashEntry> {
    let mut out = Vec::new();
    for sub in subdirs(dir) {
        if prefix.is_none() {
            if sub.file_name().is_some_and(|n| n == "synced") {
                continue;
            }
            if sub.join(".claude-plugin").join("plugin.json").is_file() {
                plugin_dirs.push(sub.clone());
            }
        }
        if let Some(e) = read_skill(&sub, source, prefix) {
            out.push(e);
        }
    }
    out
}

/// Anciennes commandes `commands/**/*.md` : `a/b.md` donne `a:b`.
pub fn scan_commands_dir(dir: &Path, source: Source, prefix: Option<&str>) -> Vec<SlashEntry> {
    fn walk(dir: &Path, rel: &str, depth: u32, source: Source, prefix: Option<&str>, out: &mut Vec<SlashEntry>) {
        if depth > 6 {
            return;
        }
        let mut items: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
        items.sort();
        for p in items {
            let Some(name) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
            if p.is_dir() {
                walk(&p, &format!("{rel}{name}:"), depth + 1, source, prefix, out);
            } else if let Some(stem) = name.strip_suffix(".md") {
                if let Some(e) = read_command_file(&p, &format!("{rel}{stem}"), source, prefix) {
                    out.push(e);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, "", 0, source, prefix, &mut out);
    out
}

fn read_command_file(path: &Path, name: &str, source: Source, prefix: Option<&str>) -> Option<SlashEntry> {
    let text = std::fs::read_to_string(path).ok()?;
    let fm = parse_frontmatter(&text);
    if !fm.user_invocable || name.is_empty() {
        return None;
    }
    Some(entry_from(&fm, with_prefix(prefix, name), source))
}

/// Dossiers « projet » : celui de la conversation puis ses parents jusqu'à la racine du
/// dépôt git (dossier contenant `.git`, fichier ou dossier). Hors dépôt : le dossier seul.
pub fn project_dirs(cwd: &Path) -> Vec<PathBuf> {
    let mut chain = Vec::new();
    let mut cur = Some(cwd);
    while let Some(d) = cur {
        chain.push(d.to_path_buf());
        if d.join(".git").exists() {
            return chain;
        }
        cur = d.parent();
    }
    vec![cwd.to_path_buf()]
}

/// Lit un fichier JSON (absent ou illisible : `Null`).
fn read_json(path: &Path) -> Value {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

/// `enabledPlugins` fusionné clé par clé : utilisateur, puis projet, puis local.
pub fn enabled_plugins(claude_dir: &Path, cwd: &Path) -> BTreeMap<String, bool> {
    let mut map = BTreeMap::new();
    let files = [
        claude_dir.join("settings.json"),
        cwd.join(".claude").join("settings.json"),
        cwd.join(".claude").join("settings.local.json"),
    ];
    for f in files {
        if let Some(obj) = read_json(&f).get("enabledPlugins").and_then(Value::as_object) {
            for (k, v) in obj {
                if let Some(b) = v.as_bool() {
                    map.insert(k.clone(), b);
                }
            }
        }
    }
    map
}

fn same_path(a: &str, b: &Path) -> bool {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(&b.to_string_lossy())
}

/// Dossiers des plugins installés et activés : `(identifiant, dossier)`.
pub fn installed_enabled_plugins(claude_dir: &Path, cwd: &Path) -> Vec<(String, PathBuf)> {
    let enabled = enabled_plugins(claude_dir, cwd);
    let installed = read_json(&claude_dir.join("plugins").join("installed_plugins.json"));
    let Some(plugins) = installed.get("plugins").and_then(Value::as_object) else { return Vec::new() };
    let mut out = Vec::new();
    for (id, installs) in plugins {
        if enabled.get(id) != Some(&true) {
            continue;
        }
        // Version 2 : liste d'installations ; version 1 : un seul objet.
        let list: Vec<&Value> = match installs {
            Value::Array(a) => a.iter().collect(),
            v @ Value::Object(_) => vec![v],
            _ => continue,
        };
        // Installation de portée utilisateur, ou du projet de la conversation.
        let pick = list.iter().find(|i| {
            let scope = i.get("scope").and_then(Value::as_str).unwrap_or("user");
            scope == "user" || i.get("projectPath").and_then(Value::as_str).is_some_and(|p| project_dirs(cwd).iter().any(|d| same_path(p, d)))
        });
        if let Some(path) = pick.and_then(|i| i.get("installPath")).and_then(Value::as_str) {
            let p = PathBuf::from(path);
            if p.is_dir() {
                out.push((id.clone(), p));
            }
        }
    }
    out
}

/// Chemins d'un champ `skills` / `commands` de `plugin.json` (chaîne ou liste).
fn manifest_paths(manifest: &Value, key: &str, root: &Path) -> Vec<PathBuf> {
    let rel: Vec<&str> = match manifest.get(key) {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    rel.into_iter()
        .map(|r| root.join(r.trim_start_matches("./")))
        .filter(|p| p.starts_with(root) && !r_escapes(p, root))
        .collect()
}

/// Refuse un chemin qui sort du plugin (`..`).
fn r_escapes(p: &Path, root: &Path) -> bool {
    p.strip_prefix(root).map(|r| r.components().any(|c| matches!(c, std::path::Component::ParentDir))).unwrap_or(true)
}

/// Skills et commandes d'un plugin, nommés `<nom du plugin>:<nom>`. Nom du plugin : `name`
/// de `.claude-plugin/plugin.json`, sinon la partie avant `@` de l'identifiant.
pub fn scan_plugin(root: &Path, id: &str) -> Vec<SlashEntry> {
    let manifest = read_json(&root.join(".claude-plugin").join("plugin.json"));
    let ns = manifest
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| id.split('@').next().unwrap_or(id).to_string());
    let p = Some(ns.as_str());
    let mut out = Vec::new();
    let mut ignored = Vec::new();
    // SKILL.md à la racine du plugin.
    if root.join("SKILL.md").is_file() {
        if let Ok(text) = std::fs::read_to_string(root.join("SKILL.md")) {
            let fm = parse_frontmatter(&text);
            if fm.user_invocable {
                let base = fm.name.clone().unwrap_or_else(|| ns.clone());
                out.push(entry_from(&fm, with_prefix(p, &base), Source::Plugin));
            }
        }
    }
    let mut skill_paths = vec![root.join("skills")];
    skill_paths.extend(manifest_paths(&manifest, "skills", root));
    for sp in skill_paths {
        if sp.join("SKILL.md").is_file() {
            out.extend(read_skill(&sp, Source::Plugin, p));
        } else {
            out.extend(scan_skills_dir(&sp, Source::Plugin, p, &mut ignored));
        }
    }
    let mut cmd_paths = vec![root.join("commands")];
    cmd_paths.extend(manifest_paths(&manifest, "commands", root));
    for cp in cmd_paths {
        if cp.is_file() {
            let stem = cp.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            out.extend(read_command_file(&cp, &stem, Source::Plugin, p));
        } else {
            out.extend(scan_commands_dir(&cp, Source::Plugin, p));
        }
    }
    out
}

/// Ajoute une entrée si son nom n'est pas déjà pris (la première trouvée l'emporte).
fn push_unique(list: &mut Vec<SlashEntry>, seen: &mut HashMap<String, usize>, e: SlashEntry) {
    if !seen.contains_key(&e.name) {
        seen.insert(e.name.clone(), list.len());
        list.push(e);
    }
}

/// Tout ce qui se trouve sur disque pour une conversation lancée dans `cwd`. Ordre de
/// priorité pour un même nom : personnel avant projet, skill avant commande.
pub fn discover(claude_dir: &Path, cwd: Option<&Path>) -> Vec<SlashEntry> {
    let mut list = Vec::new();
    let mut seen = HashMap::new();
    let mut skill_plugins = Vec::new();
    for e in scan_skills_dir(&claude_dir.join("skills"), Source::User, None, &mut skill_plugins) {
        push_unique(&mut list, &mut seen, e);
    }
    let projects = cwd.map(project_dirs).unwrap_or_default();
    for d in &projects {
        // Le dossier personnel n'est pas un dossier de projet.
        if d.join(".claude") == claude_dir {
            continue;
        }
        let mut found = Vec::new();
        let skills = scan_skills_dir(&d.join(".claude").join("skills"), Source::Project, None, &mut found);
        // Plugins d'un dossier de skills : seulement dans le dossier de la conversation.
        if Some(d.as_path()) == cwd {
            skill_plugins.extend(found);
        }
        for e in skills {
            push_unique(&mut list, &mut seen, e);
        }
    }
    for e in scan_commands_dir(&claude_dir.join("commands"), Source::User, None) {
        push_unique(&mut list, &mut seen, e);
    }
    for d in &projects {
        if d.join(".claude") == claude_dir {
            continue;
        }
        for e in scan_commands_dir(&d.join(".claude").join("commands"), Source::Project, None) {
            push_unique(&mut list, &mut seen, e);
        }
    }
    // Plugins.
    let enabled = cwd.map(|c| enabled_plugins(claude_dir, c)).unwrap_or_else(|| enabled_plugins(claude_dir, Path::new("")));
    let mut plugins = cwd.map(|c| installed_enabled_plugins(claude_dir, c)).unwrap_or_else(|| installed_enabled_plugins(claude_dir, Path::new("")));
    for dir in skill_plugins {
        let manifest = read_json(&dir.join(".claude-plugin").join("plugin.json"));
        let name = manifest.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        let id = format!("{name}@skills-dir");
        let default_on = manifest.get("defaultEnabled").and_then(Value::as_bool).unwrap_or(true);
        if enabled.get(&id).copied().unwrap_or(default_on) {
            plugins.push((id, dir));
        }
    }
    for (id, root) in plugins {
        for e in scan_plugin(&root, &id) {
            push_unique(&mut list, &mut seen, e);
        }
    }
    list
}

// ---------------------------------------------------------------------------
// Liste chargée par Claude Code (`skill_listing` dans le .jsonl)
// ---------------------------------------------------------------------------

/// Skills annoncés par Claude Code dans la conversation, dans l'ordre : `(nom, description)`.
#[derive(Debug, Default, Clone)]
pub struct Listing {
    /// Déjà lu jusqu'ici (octets).
    offset: u64,
    pub skills: Vec<(String, String)>,
    /// Au moins une ligne `skill_listing` trouvée.
    pub found: bool,
}

/// Applique une ligne `skill_listing` : une liste initiale remplace tout, les suivantes
/// ajoutent des skills. Descriptions lues dans `content` (`- nom: description`).
pub fn apply_listing_line(listing: &mut Listing, line: &str) {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    let Some(att) = v.get("attachment") else { return };
    if att.get("type").and_then(Value::as_str) != Some("skill_listing") {
        return;
    }
    let names: Vec<String> = att.get("names").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    let content = att.get("content").and_then(Value::as_str).unwrap_or("");
    let mut descs: HashMap<&str, String> = HashMap::new();
    for l in content.lines() {
        let Some(rest) = l.strip_prefix("- ") else { continue };
        // Le nom peut contenir `:` (plugin) : on cherche un nom connu au début.
        let found = names.iter().filter(|n| rest == n.as_str() || rest.starts_with(&format!("{n}: "))).max_by_key(|n| n.len());
        if let Some(n) = found {
            let d = rest[n.len()..].trim_start_matches(':').trim();
            descs.insert(n.as_str(), one_line(d));
        }
    }
    if att.get("isInitial").and_then(Value::as_bool).unwrap_or(false) {
        listing.skills.clear();
    }
    listing.found = true;
    for n in &names {
        let d = descs.get(n.as_str()).cloned().unwrap_or_default();
        if let Some(existing) = listing.skills.iter_mut().find(|(x, _)| x == n) {
            existing.1 = d;
        } else {
            listing.skills.push((n.clone(), d));
        }
    }
}

/// Lit la suite du fichier à partir de `listing.offset` (seules les lignes qui contiennent
/// `skill_listing` sont décodées). Fichier raccourci : relu depuis le début.
pub fn update_listing(path: &Path, listing: &mut Listing) {
    let Ok(mut file) = File::open(path) else { return };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if listing.offset > len {
        *listing = Listing::default();
    }
    if file.seek(SeekFrom::Start(listing.offset)).is_err() {
        return;
    }
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut buf = Vec::new();
    let mut pos = listing.offset;
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.last() != Some(&b'\n') {
                    break; // ligne en cours d'écriture : relue la prochaine fois
                }
                pos += n as u64;
                if memfind(&buf, b"\"skill_listing\"") {
                    apply_listing_line(listing, &String::from_utf8_lossy(&buf));
                }
            }
        }
    }
    listing.offset = pos;
}

fn memfind(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Fusion : intégrées, puis disque, puis skills annoncés par Claude Code absents du disque.
/// Un skill personnel/projet/plugin remplace l'intégrée du même nom ; un skill annoncé sans
/// fichier connu et portant le nom d'une intégrée garde la description française.
pub fn merge(disk: Vec<SlashEntry>, listing: Option<&Listing>) -> Vec<SlashEntry> {
    let mut by_name: BTreeMap<String, SlashEntry> = builtins().into_iter().map(|e| (e.name.clone(), e)).collect();
    for e in disk {
        by_name.insert(e.name.clone(), e);
    }
    if let Some(l) = listing {
        for (name, desc) in &l.skills {
            if by_name.contains_key(name) {
                continue;
            }
            let source = if name.contains(':') { Source::Plugin } else { Source::Builtin };
            by_name.insert(name.clone(), SlashEntry { name: name.clone(), description: desc.clone(), source, argument_hint: None });
        }
    }
    by_name.into_values().collect()
}

/// État partagé : listes `skill_listing` déjà lues, par fichier de conversation.
#[derive(Default)]
pub struct ListingCache(Mutex<HashMap<PathBuf, Listing>>);

impl ListingCache {
    pub fn read(&self, path: &Path) -> Listing {
        let mut map = self.0.lock().unwrap();
        let l = map.entry(path.to_path_buf()).or_default();
        update_listing(path, l);
        l.clone()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn names(list: &[SlashEntry]) -> Vec<&str> {
        list.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn frontmatter_simple_and_quoted() {
        let fm = parse_frontmatter("---\nname: deploy\ndescription: \"Déployer l'appli\"\nargument-hint: [env]\n---\n\n# Titre\n");
        assert_eq!(fm.name.as_deref(), Some("deploy"));
        assert_eq!(fm.description.as_deref(), Some("Déployer l'appli"));
        assert_eq!(fm.argument_hint.as_deref(), Some("[env]"));
        assert!(fm.user_invocable);
        assert_eq!(fm.first_line.as_deref(), Some("Titre"));
    }

    #[test]
    fn frontmatter_block_and_folded_values() {
        let fm = parse_frontmatter("---\nname: x\ndescription: >\n  Première partie\n  et suite\nuser-invocable: false\n---\ncorps");
        assert_eq!(fm.description.as_deref(), Some("Première partie et suite"));
        assert!(!fm.user_invocable);
        let fm = parse_frontmatter("---\ndescription: début\n  continué\n---\n");
        assert_eq!(fm.description.as_deref(), Some("début continué"));
        let fm = parse_frontmatter("---\ndescription: 'l''outil'\n---\n");
        assert_eq!(fm.description.as_deref(), Some("l'outil"));
    }

    #[test]
    fn frontmatter_absent_or_unclosed() {
        let fm = parse_frontmatter("\n\nFixe le bug $ARGUMENTS\nsuite");
        assert_eq!(fm.name, None);
        assert_eq!(fm.description, None);
        assert_eq!(fm.first_line.as_deref(), Some("Fixe le bug $ARGUMENTS"));
        let fm = parse_frontmatter("---\nname: x\npas de fin");
        assert_eq!(fm.name, None);
        assert_eq!(fm.first_line.as_deref(), Some("---"));
        let fm = parse_frontmatter("\u{feff}---\r\nname: crlf\r\n---\r\n");
        assert_eq!(fm.name.as_deref(), Some("crlf"));
    }

    #[test]
    fn one_line_collapses_and_truncates() {
        assert_eq!(one_line("a\n  b\tc"), "a b c");
        let long = "x".repeat(400);
        let t = one_line(&long);
        assert_eq!(t.chars().count(), MAX_DESCRIPTION);
        assert!(t.ends_with('…'));
    }

    #[test]
    fn discovers_user_project_commands_and_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        let claude = tmp.path().join("home").join(".claude");
        // Personnel.
        write(&claude.join("skills/revue/SKILL.md"), "---\ndescription: Revue perso\n---\n");
        write(&claude.join("skills/cache/SKILL.md"), "---\nname: cache\ndescription: d\nuser-invocable: false\n---\n");
        write(&claude.join("skills/synced/abc/SKILL.md"), "---\nname: synchro\n---\n");
        write(&claude.join("commands/outils/format.md"), "---\ndescription: Formater\nargument-hint: [fichier]\n---\n");
        // Projet : dépôt avec un sous-dossier comme dossier de conversation.
        let repo = tmp.path().join("depot");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let cwd = repo.join("app");
        write(&repo.join(".claude/skills/revue/SKILL.md"), "---\ndescription: Revue projet\n---\n");
        write(&repo.join(".claude/skills/deployer/SKILL.md"), "---\nname: deploy\n---\nDéploie l'app\n");
        write(&cwd.join(".claude/commands/test.md"), "Lance les tests\n");
        // Au-dessus du dépôt : ignoré.
        write(&tmp.path().join(".claude/commands/dehors.md"), "x");
        // Plugin installé et activé, avec chemins du manifeste.
        let plug = claude.join("plugins/cache/mk/outil/1.0");
        write(&plug.join(".claude-plugin/plugin.json"), r#"{"name":"outil","skills":["./extra/special"]}"#);
        write(&plug.join("skills/aide/SKILL.md"), "---\ndescription: Aide du plugin\n---\n");
        write(&plug.join("extra/special/SKILL.md"), "---\nname: outil:special\ndescription: S\n---\n");
        write(&plug.join("commands/go.md"), "---\ndescription: Go\n---\n");
        // Plugin installé mais désactivé.
        let off = claude.join("plugins/cache/mk/eteint/1.0");
        write(&off.join("skills/rien/SKILL.md"), "---\ndescription: R\n---\n");
        let installed = serde_json::json!({"version": 2, "plugins": {
            "outil@mk": [{"scope": "user", "installPath": plug}],
            "eteint@mk": [{"scope": "user", "installPath": off}],
        }});
        write(&claude.join("plugins/installed_plugins.json"), &installed.to_string());
        write(&claude.join("settings.json"), r#"{"enabledPlugins":{"outil@mk":true,"eteint@mk":true}}"#);
        write(&cwd.join(".claude/settings.local.json"), r#"{"enabledPlugins":{"eteint@mk":false}}"#);

        let list = discover(&claude, Some(&cwd));
        assert_eq!(names(&list), vec!["revue", "deploy", "outils:format", "test", "outil:aide", "outil:special", "outil:go"]);
        let revue = &list[0];
        assert_eq!((revue.source, revue.description.as_str()), (Source::User, "Revue perso"));
        assert_eq!(list[1].description, "Déploie l'app");
        assert_eq!(list[1].source, Source::Project);
        assert_eq!(list[2].argument_hint.as_deref(), Some("[fichier]"));
        assert_eq!(list[3].description, "Lance les tests");
        assert!(list[4..].iter().all(|e| e.source == Source::Plugin));
    }

    #[test]
    fn project_dirs_stop_at_repo_root() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("r");
        std::fs::create_dir_all(repo.join("a/b")).unwrap();
        std::fs::write(repo.join(".git"), "gitdir: ailleurs").unwrap(); // worktree : fichier .git
        assert_eq!(project_dirs(&repo.join("a/b")), vec![repo.join("a/b"), repo.join("a"), repo.clone()]);
        let lone = tmp.path().join("seul");
        std::fs::create_dir_all(&lone).unwrap();
        assert_eq!(project_dirs(&lone), vec![lone.clone()]);
    }

    #[test]
    fn skills_dir_plugin_is_namespaced() {
        let tmp = tempfile::tempdir().unwrap();
        let claude = tmp.path().join(".claude");
        write(&claude.join("skills/monplug/.claude-plugin/plugin.json"), r#"{"name":"mp"}"#);
        write(&claude.join("skills/monplug/skills/a/SKILL.md"), "---\ndescription: A\n---\n");
        let list = discover(&claude, None);
        assert_eq!(names(&list), vec!["mp:a"]);
        write(&claude.join("settings.json"), r#"{"enabledPlugins":{"mp@skills-dir":false}}"#);
        assert!(discover(&claude, None).is_empty());
    }

    fn listing_line(initial: bool, names: &[&str], content: &str) -> String {
        serde_json::json!({"type": "attachment", "attachment": {"type": "skill_listing", "content": content, "isInitial": initial, "names": names}}).to_string()
    }

    #[test]
    fn parses_skill_listing_lines() {
        let mut l = Listing::default();
        apply_listing_line(&mut l, &listing_line(true, &["a", "p:b", "p"], "- a: Skill A.\n- p:b: Du plugin\nsuite de la description\n- p: court"));
        assert_eq!(l.skills, vec![("a".into(), "Skill A.".into()), ("p:b".into(), "Du plugin".into()), ("p".into(), "court".into())]);
        // Ajout incrémental, puis liste initiale qui remplace tout.
        apply_listing_line(&mut l, &listing_line(false, &["c"], "- c"));
        assert_eq!(l.skills.len(), 4);
        assert_eq!(l.skills[3], ("c".into(), String::new()));
        apply_listing_line(&mut l, &listing_line(true, &["z"], "- z: Z"));
        assert_eq!(l.skills, vec![("z".into(), "Z".into())]);
        // Lignes sans rapport ignorées.
        apply_listing_line(&mut l, r#"{"type":"user","message":"skill_listing"}"#);
        apply_listing_line(&mut l, "pas du json");
        assert_eq!(l.skills.len(), 1);
    }

    #[test]
    fn reads_listing_incrementally_from_file() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("s.jsonl");
        let first = listing_line(true, &["a"], "- a: A");
        std::fs::write(&f, format!("{{\"type\":\"user\"}}\n{first}\n")).unwrap();
        let cache = ListingCache::default();
        let l = cache.read(&f);
        assert!(l.found);
        assert_eq!(l.skills, vec![("a".into(), "A".into())]);
        // Ligne ajoutée, la dernière pas encore terminée.
        let more = listing_line(false, &["b"], "- b: B");
        let mut text = std::fs::read_to_string(&f).unwrap();
        text.push_str(&format!("{more}\n{{\"partiel"));
        std::fs::write(&f, text).unwrap();
        let l = cache.read(&f);
        assert_eq!(names_of(&l), vec!["a", "b"]);
        // Fichier réécrit plus court : relu depuis le début.
        std::fs::write(&f, format!("{}\n", listing_line(true, &["x"], "- x: X"))).unwrap();
        assert_eq!(names_of(&cache.read(&f)), vec!["x"]);
    }

    fn names_of(l: &Listing) -> Vec<&str> {
        l.skills.iter().map(|(n, _)| n.as_str()).collect()
    }

    #[test]
    fn merge_prefers_disk_and_french_builtins() {
        let disk = vec![SlashEntry { name: "compact".into(), description: "Le mien".into(), source: Source::User, argument_hint: None }];
        let listing = Listing { offset: 0, found: true, skills: vec![("init".into(), "Initialize".into()), ("dataviz".into(), "Charts".into()), ("p:x".into(), "X".into())] };
        let list = merge(disk, Some(&listing));
        let get = |n: &str| list.iter().find(|e| e.name == n).unwrap();
        assert_eq!(get("compact").source, Source::User);
        assert_eq!(get("init").description, "Créer un guide CLAUDE.md pour le projet");
        assert_eq!(get("dataviz").source, Source::Builtin);
        assert_eq!(get("p:x").source, Source::Plugin);
        assert!(list.windows(2).all(|w| w[0].name < w[1].name));
    }

    /// Sur les vrais fichiers (lancé à la main : `cargo test real_slash -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn real_slash_discovery() {
        let claude = dirs::home_dir().unwrap().join(".claude");
        let cwd = std::env::current_dir().unwrap();
        for e in discover(&claude, Some(&cwd)) {
            println!("{:?} /{} — {}", e.source, e.name, e.description.chars().take(60).collect::<String>());
        }
    }
}
