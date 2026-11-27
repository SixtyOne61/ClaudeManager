//! Propositions de skills (voir GLOSSARY.md, « Terminer », « Analyse de fin de conversation »,
//! « Proposition de skill », et `.scratch/propositions-skills/spec.md`).
//!
//! Quand l'utilisateur clique sur **Terminer**, l'interface (`src/skills.ts`) tape dans le
//! terminal intégré de la conversation la question de [`analysis_prompt`] (ADR 0003), attend
//! la fin du tour, puis [`record_reply`] lit la réponse dans le `.jsonl` et la rattache à une
//! proposition. Le comptage se fait donc au fil de l'eau, sans autre appel au modèle.
//!
//! Les propositions sont gardées dans `skill-proposals.json` (à part de `config.json`, que
//! `save_config` réécrit en entier). Une proposition refusée ou déjà créée est gardée pour ne
//! jamais être reproposée ; les demandes qui s'y rattachent ne sont pas comptées.
//!
//! Rappel : dû quand la dernière revue date d'au moins `window_days` jours (ou n'a jamais eu
//! lieu) et qu'une proposition en attente compte au moins `threshold` occurrences dans les
//! `window_days` derniers jours ([`listing`]).

use crate::config::{write_atomic, SkillSettings};
use crate::conversation::{read_chunk, Entry};
use crate::handoff::last_reply;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Marqueur en tête de la question : explique ce message si la conversation est reprise.
pub const MARKER: &str = "[Analyse de fin de conversation]";

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Pending,
    Refused,
    Created,
}

/// Une demande repérée dans une conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Occurrence {
    /// Moment de l'analyse (ms depuis l'époque Unix).
    pub at: u64,
    /// Dossier du projet (le parent pour un worktree).
    pub project: String,
    pub session_id: String,
    pub summary: String,
}

/// Groupe de demandes semblables.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Proposal {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: Status,
    pub created_at: u64,
    pub occurrences: Vec<Occurrence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    pub proposals: Vec<Proposal>,
    /// Dernière ouverture de la fenêtre « Skills proposés » (ms), `None` : jamais.
    pub last_review: Option<u64>,
}

/// Réponse de l'analyse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    None,
    Existing { id: String, summary: String },
    New { name: String, description: String, summary: String },
}

// ---- Fichier ------------------------------------------------------------------------------

/// Propositions gardées en mémoire, et leur fichier.
pub struct SkillStore {
    path: PathBuf,
    store: Mutex<Store>,
}

impl SkillStore {
    pub fn load(app_dir: &Path) -> Self {
        let path = app_dir.join("skill-proposals.json");
        let store = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { path, store: Mutex::new(store) }
    }

    pub fn get(&self) -> Store {
        self.store.lock().unwrap().clone()
    }

    /// Modifie les propositions et les enregistre si elles ont changé.
    pub fn update<R>(&self, change: impl FnOnce(&mut Store) -> R) -> Result<R, String> {
        let mut store = self.store.lock().unwrap();
        let before = store.clone();
        let r = change(&mut store);
        if *store != before {
            let text = serde_json::to_string_pretty(&*store).map_err(|e| e.to_string())?;
            write_atomic(&self.path, text.as_bytes()).map_err(|e| e.to_string())?;
        }
        Ok(r)
    }
}

// ---- Règles -------------------------------------------------------------------------------

/// Retire les occurrences de plus de `window_days` jours ; une proposition en attente qui
/// n'en a plus disparaît (refusées et créées sont gardées).
pub fn purge(store: &mut Store, now: u64, window_days: u32) {
    let since = now.saturating_sub(window_days as u64 * DAY_MS);
    for p in &mut store.proposals {
        p.occurrences.retain(|o| o.at >= since);
    }
    store.proposals.retain(|p| p.status != Status::Pending || !p.occurrences.is_empty());
}

/// Identifiant libre suivant (`p1`, `p2`…) : court, facile à recopier pour l'agent.
fn next_id(store: &Store) -> String {
    let max = store.proposals.iter().filter_map(|p| p.id.strip_prefix('p')?.parse::<u32>().ok()).max().unwrap_or(0);
    format!("p{}", max + 1)
}

/// Rattache un verdict. Renvoie l'identifiant de la proposition touchée, ou `None` (verdict
/// « aucun », identifiant inconnu, proposition refusée ou créée, même conversation déjà
/// comptée).
pub fn record(store: &mut Store, verdict: Verdict, project: &str, session_id: &str, now: u64) -> Option<String> {
    let occurrence = |summary: String| Occurrence { at: now, project: project.to_string(), session_id: session_id.to_string(), summary };
    match verdict {
        Verdict::None => None,
        Verdict::Existing { id, summary } => {
            let p = store.proposals.iter_mut().find(|p| p.id == id)?;
            if p.status != Status::Pending {
                return None;
            }
            // Conversation terminée plusieurs fois : une seule occurrence (la dernière).
            p.occurrences.retain(|o| o.session_id != session_id);
            p.occurrences.push(occurrence(summary));
            Some(id)
        }
        Verdict::New { name, description, summary } => {
            let id = next_id(store);
            store.proposals.push(Proposal {
                id: id.clone(),
                name,
                description,
                status: Status::Pending,
                created_at: now,
                occurrences: vec![occurrence(summary)],
            });
            Some(id)
        }
    }
}

/// Occurrences d'une proposition dans la fenêtre.
pub fn count_in_window(p: &Proposal, now: u64, window_days: u32) -> usize {
    let since = now.saturating_sub(window_days as u64 * DAY_MS);
    p.occurrences.iter().filter(|o| o.at >= since).count()
}

/// Le rappel est dû : revue ancienne (ou jamais faite) et une proposition au seuil.
pub fn reminder_due(store: &Store, now: u64, settings: &SkillSettings) -> bool {
    let review_old = store.last_review.is_none_or(|t| now.saturating_sub(t) >= settings.window_days as u64 * DAY_MS);
    review_old
        && store
            .proposals
            .iter()
            .any(|p| p.status == Status::Pending && count_in_window(p, now, settings.window_days) >= settings.threshold as usize)
}

/// Portée proposée : `Some(projet)` si toutes les occurrences viennent du même projet, sinon
/// `None` (skill de l'utilisateur).
pub fn proposed_scope(p: &Proposal) -> Option<String> {
    let first = p.occurrences.first()?.project.clone();
    p.occurrences.iter().all(|o| same_path(&o.project, &first)).then_some(first)
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
    norm(a) == norm(b)
}

/// Projet d'une conversation : le dossier parent pour un worktree, sinon `cwd`.
pub fn project_of(cwd: &str) -> String {
    crate::worktrees::detect(cwd).map(|(parent, _)| parent).unwrap_or_else(|| cwd.to_string())
}

// ---- Question et réponse ------------------------------------------------------------------

/// Question tapée dans la conversation. `skills` : skills et commandes déjà disponibles
/// (noms) ; les propositions connues (toutes, pour que l'agent ne repropose pas une refusée).
pub fn analysis_prompt(skills: &[String], store: &Store) -> String {
    let mut out = format!(
        "{MARKER} Cette conversation est terminée. Sans lancer aucun outil, dis-moi si ce que je t'ai demandé ici pourrait devenir un skill réutilisable : une tâche que je risque de redemander, avec des étapes, des conventions ou un savoir qui ne se devinent pas. Une simple question ponctuelle, ou une demande déjà couverte par un skill existant, ne compte pas."
    );
    if skills.is_empty() {
        out.push_str("\n\nSkills et commandes déjà disponibles : aucun.");
    } else {
        out.push_str(&format!("\n\nSkills et commandes déjà disponibles : {}.", skills.join(", ")));
    }
    if store.proposals.is_empty() {
        out.push_str("\n\nPropositions déjà repérées : aucune.");
    } else {
        out.push_str("\n\nPropositions déjà repérées (si ma demande correspond à l'une d'elles, même refusée, rattache-la) :");
        for p in &store.proposals {
            out.push_str(&format!("\n- {} : {} — {}", p.id, p.name, p.description));
        }
    }
    out.push_str(
        "\n\nRéponds uniquement par un objet JSON, sur une ligne, de l'une de ces formes :\n\
         {\"verdict\":\"aucun\"}\n\
         {\"verdict\":\"existant\",\"proposition\":\"<id>\",\"resume\":\"<ma demande en une phrase>\"}\n\
         {\"verdict\":\"nouveau\",\"nom\":\"<nom-du-skill en kebab-case>\",\"description\":\"<ce que ferait le skill, une ou deux phrases>\",\"resume\":\"<ma demande en une phrase>\"}",
    );
    out
}

/// Premier objet JSON d'un texte (bloc ```json``` ou accolades), tolérant le texte autour.
fn first_json_object(text: &str) -> Option<serde_json::Value> {
    let bytes = text.as_bytes();
    let mut start = 0;
    while let Some(i) = text[start..].find('{').map(|i| i + start) {
        let mut depth = 0i32;
        let mut in_str = false;
        let mut escaped = false;
        for (j, &b) in bytes.iter().enumerate().skip(i) {
            if in_str {
                match b {
                    _ if escaped => escaped = false,
                    b'\\' => escaped = true,
                    b'"' => in_str = false,
                    _ => {}
                }
                continue;
            }
            match b {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text[i..=j]) {
                            if v.is_object() {
                                return Some(v);
                            }
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
        start = i + 1;
    }
    None
}

/// Lit le verdict d'une réponse. `None` : réponse illisible.
pub fn parse_verdict(reply: &str) -> Option<Verdict> {
    let v = first_json_object(reply)?;
    let field = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    match field("verdict")?.to_lowercase().as_str() {
        "aucun" => Some(Verdict::None),
        "existant" => Some(Verdict::Existing { id: field("proposition")?, summary: field("resume").unwrap_or_default() }),
        "nouveau" => Some(Verdict::New {
            name: field("nom")?,
            description: field("description").unwrap_or_default(),
            summary: field("resume").unwrap_or_default(),
        }),
        _ => None,
    }
}

/// Lit dans le `.jsonl` le verdict de la réponse à la question. `None` : pas de réponse
/// lisible (encore en cours d'écriture, ou invalide).
pub fn read_verdict(transcript: &Path, prompt: &str) -> Option<Verdict> {
    let entries: Vec<Entry> = read_chunk(transcript, 0, 0).entries;
    parse_verdict(&last_reply(&entries, prompt)?)
}

/// Premier message de la conversation qui crée le skill.
pub fn creation_message(p: &Proposal, project_scope: bool) -> String {
    let scope = if project_scope {
        "dans ce projet (`.claude/skills/`)"
    } else {
        "pour moi, dans tous mes projets (`~/.claude/skills/`)"
    };
    let mut out = format!(
        "/skill-creator Crée un skill « {} » {scope}.\n\nCe qu'il ferait : {}\n\nJe l'ai demandé {} fois récemment :",
        p.name,
        p.description,
        p.occurrences.len()
    );
    for o in &p.occurrences {
        out.push_str(&format!("\n- {}", if o.summary.is_empty() { "(sans résumé)" } else { &o.summary }));
    }
    out.push_str("\n\nRelis avec moi ce qui ne se devine pas (étapes, conventions, pièges) avant d'écrire le skill.");
    out
}

// ---- Liste pour l'interface ---------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    #[serde(flatten)]
    pub proposal: Proposal,
    /// Occurrences dans la fenêtre.
    pub count: usize,
    /// Projet proposé pour un skill de projet (toutes les occurrences y sont), sinon `None`.
    pub project_scope: Option<String>,
    /// Dossier de la conversation de création pour un skill de l'utilisateur : projet de
    /// l'occurrence la plus récente.
    pub latest_project: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// Propositions en attente, celles au seuil d'abord (puis par nombre d'occurrences).
    pub proposals: Vec<ProposalView>,
    pub due: bool,
    pub threshold: u32,
}

pub fn listing(store: &Store, now: u64, settings: &SkillSettings) -> Listing {
    let mut proposals: Vec<ProposalView> = store
        .proposals
        .iter()
        .filter(|p| p.status == Status::Pending)
        .map(|p| ProposalView {
            count: count_in_window(p, now, settings.window_days),
            project_scope: proposed_scope(p),
            latest_project: p.occurrences.iter().max_by_key(|o| o.at).map(|o| o.project.clone()),
            proposal: p.clone(),
        })
        .collect();
    proposals.sort_by(|a, b| b.count.cmp(&a.count).then(b.proposal.created_at.cmp(&a.proposal.created_at)));
    Listing { proposals, due: reminder_due(store, now, settings), threshold: settings.threshold }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> SkillSettings {
        SkillSettings { enabled: true, window_days: 7, threshold: 3 }
    }

    fn new(name: &str) -> Verdict {
        Verdict::New { name: name.into(), description: "d".into(), summary: "s".into() }
    }

    fn existing(id: &str) -> Verdict {
        Verdict::Existing { id: id.into(), summary: "s".into() }
    }

    #[test]
    fn parses_verdicts() {
        assert_eq!(parse_verdict(r#"{"verdict":"aucun"}"#), Some(Verdict::None));
        assert_eq!(
            parse_verdict("Voici :\n```json\n{\"verdict\":\"existant\",\"proposition\":\"p2\",\"resume\":\"fait la release\"}\n```"),
            Some(Verdict::Existing { id: "p2".into(), summary: "fait la release".into() })
        );
        assert_eq!(
            parse_verdict(r#"{"verdict":"nouveau","nom":"notes-de-version","description":"Rédige {les} notes","resume":"r"}"#),
            Some(Verdict::New { name: "notes-de-version".into(), description: "Rédige {les} notes".into(), summary: "r".into() })
        );
        // Accolades avant l'objet, verdict inconnu, champs manquants, pas de JSON.
        assert_eq!(parse_verdict(r#"texte {pas du json} puis {"verdict":"aucun"}"#), Some(Verdict::None));
        assert_eq!(parse_verdict(r#"{"verdict":"peut-être"}"#), None);
        assert_eq!(parse_verdict(r#"{"verdict":"nouveau"}"#), None);
        assert_eq!(parse_verdict(r#"{"verdict":"existant"}"#), None);
        assert_eq!(parse_verdict("Aucun skill ici."), None);
    }

    #[test]
    fn records_new_and_existing() {
        let mut s = Store::default();
        assert_eq!(record(&mut s, new("a"), "C:\\p", "s1", 10), Some("p1".into()));
        assert_eq!(record(&mut s, new("b"), "C:\\p", "s2", 20), Some("p2".into()));
        assert_eq!(record(&mut s, existing("p1"), "C:\\q", "s3", 30), Some("p1".into()));
        assert_eq!(s.proposals[0].occurrences.len(), 2);
        // Même conversation terminée deux fois : une occurrence.
        record(&mut s, existing("p1"), "C:\\q", "s3", 40);
        assert_eq!(s.proposals[0].occurrences.len(), 2);
        // Inconnue, aucun : rien.
        assert_eq!(record(&mut s, existing("p9"), "C:\\p", "s4", 50), None);
        assert_eq!(record(&mut s, Verdict::None, "C:\\p", "s4", 50), None);
        // Refusée ou créée : non comptée.
        s.proposals[1].status = Status::Refused;
        assert_eq!(record(&mut s, existing("p2"), "C:\\p", "s5", 60), None);
        assert_eq!(s.proposals[1].occurrences.len(), 1);
        // Identifiant suivant après le plus grand.
        s.proposals.remove(0);
        assert_eq!(record(&mut s, new("c"), "C:\\p", "s6", 70), Some("p3".into()));
    }

    #[test]
    fn purges_old_occurrences() {
        let now = 30 * DAY_MS;
        let mut s = Store::default();
        record(&mut s, new("vieille"), "p", "s1", now - 8 * DAY_MS);
        record(&mut s, new("mixte"), "p", "s2", now - 8 * DAY_MS);
        record(&mut s, existing("p2"), "p", "s3", now - DAY_MS);
        record(&mut s, new("refusée"), "p", "s4", now - 9 * DAY_MS);
        s.proposals[2].status = Status::Refused;
        purge(&mut s, now, 7);
        let ids: Vec<_> = s.proposals.iter().map(|p| (p.id.as_str(), p.occurrences.len())).collect();
        assert_eq!(ids, vec![("p2", 1), ("p3", 0)]);
    }

    #[test]
    fn reminder_due_needs_threshold_and_old_review() {
        let now = 100 * DAY_MS;
        let mut s = Store::default();
        record(&mut s, new("a"), "p", "s1", now - DAY_MS);
        record(&mut s, existing("p1"), "p", "s2", now - DAY_MS);
        assert!(!reminder_due(&s, now, &settings()));
        record(&mut s, existing("p1"), "p", "s3", now);
        assert!(reminder_due(&s, now, &settings()));
        s.last_review = Some(now - 2 * DAY_MS);
        assert!(!reminder_due(&s, now, &settings()));
        s.last_review = Some(now - 7 * DAY_MS);
        assert!(reminder_due(&s, now, &settings()));
        // Occurrences hors fenêtre : pas comptées.
        assert!(!reminder_due(&s, now + 8 * DAY_MS, &settings()));
        s.proposals[0].status = Status::Refused;
        assert!(!reminder_due(&s, now, &settings()));
    }

    #[test]
    fn scope_is_project_only_when_all_occurrences_share_it() {
        let mut s = Store::default();
        record(&mut s, new("a"), "C:\\Proj", "s1", 1);
        record(&mut s, existing("p1"), "c:/proj/", "s2", 2);
        assert_eq!(proposed_scope(&s.proposals[0]), Some("C:\\Proj".into()));
        record(&mut s, existing("p1"), "C:\\Autre", "s3", 3);
        assert_eq!(proposed_scope(&s.proposals[0]), None);
    }

    #[test]
    fn worktree_counts_as_parent_project() {
        assert_eq!(project_of("C:\\Proj\\.claude\\worktrees\\wt1"), "C:\\Proj");
        assert_eq!(project_of("C:\\Proj"), "C:\\Proj");
    }

    #[test]
    fn listing_sorts_by_count() {
        let now = 10 * DAY_MS;
        let mut s = Store::default();
        record(&mut s, new("a"), "p", "s1", now);
        record(&mut s, new("b"), "p", "s2", now);
        record(&mut s, existing("p2"), "q", "s3", now);
        let l = listing(&s, now, &settings());
        assert_eq!(l.proposals.iter().map(|p| (p.proposal.id.as_str(), p.count)).collect::<Vec<_>>(), vec![("p2", 2), ("p1", 1)]);
        assert_eq!(l.proposals[0].project_scope, None);
        assert_eq!(l.proposals[1].project_scope.as_deref(), Some("p"));
        assert!(!l.due);
    }

    #[test]
    fn prompt_lists_skills_and_proposals() {
        let mut s = Store::default();
        record(&mut s, new("release"), "p", "s1", 1);
        let text = analysis_prompt(&["mon-skill".into()], &s);
        assert!(text.starts_with(MARKER));
        assert!(text.contains("mon-skill"));
        assert!(text.contains("- p1 : release — d"));
        let msg = creation_message(&s.proposals[0], true);
        assert!(msg.starts_with("/skill-creator "));
        assert!(msg.contains(".claude/skills/"));
    }

    #[test]
    fn store_saves_only_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let st = SkillStore::load(dir.path());
        st.update(|_| ()).unwrap();
        assert!(!dir.path().join("skill-proposals.json").exists());
        st.update(|s| record(s, new("a"), "p", "s1", 1)).unwrap();
        assert_eq!(SkillStore::load(dir.path()).get().proposals.len(), 1);
    }
}
