//! Hand off (voir GLOSSARY.md, « Hand off » et « Résumé de passation ») : une conversation
//! dont le contexte est trop rempli passe le relais à une nouvelle conversation du même projet.
//!
//! Le déroulé est conduit par l'interface (`src/handoff.ts`, `App.tsx`), sur un clic de
//! l'utilisateur seulement (ADR 0002) :
//! 1. la consigne du résumé de passation est tapée dans le terminal intégré de la parente ;
//! 2. à la fin du tour, [`read_summary`] lit la dernière réponse de l'agent dans le `.jsonl`
//!    (aucun fichier écrit, donc aucune permission demandée) ;
//! 3. la suite est créée dans le même dossier, avec [`first_message`] comme premier message ;
//! 4. [`apply`] met à jour l'organisation (section, couleur, lien parente → suite, place dans
//!    le hub) et la parente est archivée (`handoff_finish` dans lib.rs).
//!
//! Parente membre d'un hub : la suite y prend sa place et son rôle, et son premier message
//! liste les autres membres avec la consigne de les prévenir de son nouveau nom de messagerie.
//!
//! Le lien est gardé dans `config.json` sous `handoffLinks` (identifiant de la parente →
//! [`HandoffLink`]) ; [`successor_of`] et [`parent_of`] le lisent dans les deux sens.

use crate::config::{Config, HandoffLink};
use crate::conversation::{read_chunk, Entry};
use crate::hubs::{role_label, HandoffContext};
use serde::Serialize;
use std::path::Path;

/// Résumé de passation lu dans la parente, et premier message de la suite.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub summary: String,
    pub first_message: String,
}

/// Mêmes mots, aux espaces et retours à la ligne près.
fn same_text(a: &str, b: &str) -> bool {
    a.split_whitespace().eq(b.split_whitespace())
}

/// Dernière réponse de l'agent à la consigne `prompt` : ses textes écrits après le dernier
/// message de l'utilisateur qui reprend la consigne (à défaut, après le dernier message de
/// l'utilisateur). Les textes écrits avant la dernière action de l'agent (« Je relis le
/// fichier… ») sont laissés de côté : seule compte la réponse finale. `None` si la réponse
/// est vide, ou si l'utilisateur a écrit un autre message depuis la consigne.
pub fn last_reply(entries: &[Entry], prompt: &str) -> Option<String> {
    let is_user = |e: &Entry| matches!(e, Entry::User { command: false, .. });
    let anchor = entries
        .iter()
        .rposition(|e| matches!(e, Entry::User { text, command: false, .. } if same_text(text, prompt)))
        .or_else(|| entries.iter().rposition(is_user))?;
    let after = &entries[anchor + 1..];
    if after.iter().any(is_user) {
        return None;
    }
    let start = after.iter().rposition(|e| matches!(e, Entry::Tool { .. })).map_or(0, |i| i + 1);
    let reply = after[start..]
        .iter()
        .filter_map(|e| match e {
            Entry::Assistant { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let reply = reply.trim();
    (!reply.is_empty()).then(|| reply.to_string())
}

/// Premier message de la suite : une phrase qui la présente, puis le résumé de passation et,
/// si la parente était dans un hub, la liste des autres membres avec la consigne de les
/// prévenir de son nouveau nom de messagerie.
pub fn first_message(parent_title: &str, summary: &str, hub: Option<&HandoffContext>) -> String {
    let parent = parent_title.trim();
    let intro = if parent.is_empty() {
        "Cette conversation prend la suite d'une conversation précédente dont le contexte était trop rempli.".to_string()
    } else {
        format!("Cette conversation prend la suite de « {parent} », dont le contexte était trop rempli.")
    };
    let mut out = format!("{intro} Voici le résumé de passation qu'elle a rédigé pour toi :\n\n{}", summary.trim());
    if let Some(hub) = hub {
        out.push_str(&hub_section(hub));
    }
    out
}

/// Partie « hub » du premier message de la suite.
fn hub_section(hub: &HandoffContext) -> String {
    let mut out = format!(
        "\n\n---\n\nTu fais partie du hub « {} » de Claude Manager, avec le rôle de {} (repris de la conversation précédente).",
        hub.hub_name,
        role_label(hub.role)
    );
    if hub.members.is_empty() {
        out.push_str(" Il n'a pas d'autre membre pour l'instant.");
        return out;
    }
    out.push_str(" Ses autres membres :\n");
    for m in &hub.members {
        let name = match &m.messaging_name {
            Some(n) => format!("nom de messagerie actuel : `{n}`"),
            None => "pas lancée en ce moment".to_string(),
        };
        out.push_str(&format!("\n- « {} » ({}) — {name}", m.title, role_label(m.role)));
    }
    out.push_str(
        "\n\nTon nom de messagerie a changé avec cette nouvelle conversation : préviens dès maintenant chacun de ces membres de ton nouveau nom avec l'outil SendMessage, pour qu'ils continuent à t'écrire.",
    );
    out
}

/// Lit dans le `.jsonl` de la parente sa réponse à la consigne (voir [`last_reply`]) et
/// prépare le premier message de la suite. `None` : fichier illisible ou réponse vide.
/// `hub` : hub de la parente, le cas échéant (voir [`first_message`]).
pub fn read_summary(transcript: &Path, prompt: &str, parent_title: &str, hub: Option<&HandoffContext>) -> Option<Summary> {
    let chunk = read_chunk(transcript, 0, 0);
    let summary = last_reply(&chunk.entries, prompt)?;
    Some(Summary { first_message: first_message(parent_title, &summary, hub), summary })
}

/// Organisation après un hand off : la suite prend la section de la parente (juste après
/// elle), sa couleur et sa place dans son hub (même rôle), et le lien parente → suite est
/// enregistré. La parente reste dans sa
/// section : archivée, elle y retrouvera sa place à la restauration.
pub fn apply(cfg: &mut Config, parent: &str, successor: &str, at: u64) {
    for prefs in cfg.projects.values_mut() {
        for section in &mut prefs.sections {
            section.conversation_ids.retain(|id| id != successor);
        }
    }
    let section = cfg
        .projects
        .values_mut()
        .flat_map(|p| p.sections.iter_mut())
        .find(|s| s.conversation_ids.iter().any(|id| id == parent));
    if let Some(section) = section {
        let pos = section.conversation_ids.iter().position(|id| id == parent).map_or(0, |i| i + 1);
        section.conversation_ids.insert(pos, successor.to_string());
    }
    if let Some(color) = cfg.conversations.get(parent).and_then(|p| p.color.clone()) {
        cfg.conversations.entry(successor.to_string()).or_default().color = Some(color);
    }
    crate::hubs::replace_member(cfg, parent, successor);
    cfg.handoff_links.insert(parent.to_string(), HandoffLink { successor_id: successor.to_string(), at });
}

/// Suite d'une conversation, si elle a passé le relais.
#[cfg_attr(not(test), allow(dead_code))]
pub fn successor_of<'a>(cfg: &'a Config, parent: &str) -> Option<&'a str> {
    cfg.handoff_links.get(parent).map(|l| l.successor_id.as_str())
}

/// Parente d'une conversation, si elle est la suite d'un hand off.
#[cfg_attr(not(test), allow(dead_code))]
pub fn parent_of<'a>(cfg: &'a Config, successor: &str) -> Option<&'a str> {
    cfg.handoff_links.iter().find(|(_, l)| l.successor_id == successor).map(|(p, _)| p.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{prune_conversations, ArchiveEntry, ConversationPrefs, Section};
    use crate::conversation::parse_line;
    use std::collections::HashSet;

    const PROMPT: &str = "Rédige un résumé de passation pour une nouvelle conversation. Réponds uniquement par ce résumé, en Markdown.";

    fn user(text: &str) -> String {
        serde_json::json!({ "type": "user", "message": { "role": "user", "content": text }, "uuid": "u" }).to_string()
    }
    fn assistant(text: &str) -> String {
        serde_json::json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] }, "uuid": "a" }).to_string()
    }
    fn tool() -> String {
        serde_json::json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "C:\\p\\a.rs" } }] }, "uuid": "t" }).to_string()
    }
    fn tool_result() -> String {
        serde_json::json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "fn main() {}" }] }, "uuid": "r" }).to_string()
    }
    fn entries(lines: &[String]) -> Vec<Entry> {
        let mut out = Vec::new();
        for (i, l) in lines.iter().enumerate() {
            parse_line(l, i as u32, &mut out);
        }
        out
    }

    #[test]
    fn reads_the_reply_to_the_prompt() {
        let lines = [user("Corrige le menu"), assistant("C'est fait."), user(PROMPT), assistant("## Objectif\nCorriger le menu.")];
        assert_eq!(last_reply(&entries(&lines), PROMPT).as_deref(), Some("## Objectif\nCorriger le menu."));
        // Consigne retrouvée aux espaces près (collage sur plusieurs lignes).
        let wrapped = PROMPT.replace(". ", ".\n");
        let lines = [user(&wrapped), assistant("Résumé")];
        assert_eq!(last_reply(&entries(&lines), PROMPT).as_deref(), Some("Résumé"));
    }

    #[test]
    fn keeps_only_the_final_answer_after_actions() {
        let lines = [user(PROMPT), assistant("Je relis le fichier."), tool(), tool_result(), assistant("Partie 1"), assistant("Partie 2")];
        assert_eq!(last_reply(&entries(&lines), PROMPT).as_deref(), Some("Partie 1\n\nPartie 2"));
    }

    #[test]
    fn empty_or_overtaken_reply_gives_nothing() {
        // Pas encore de réponse, ou réponse vide.
        assert_eq!(last_reply(&entries(&[user(PROMPT)]), PROMPT), None);
        assert_eq!(last_reply(&entries(&[user(PROMPT), assistant("   ")]), PROMPT), None);
        // Seulement des actions, sans texte final.
        assert_eq!(last_reply(&entries(&[user(PROMPT), assistant("Je regarde."), tool(), tool_result()]), PROMPT), None);
        // L'utilisateur a écrit autre chose après la consigne.
        assert_eq!(last_reply(&entries(&[user(PROMPT), assistant("Résumé"), user("Autre chose")]), PROMPT), None);
        // Conversation vide.
        assert_eq!(last_reply(&[], PROMPT), None);
    }

    #[test]
    fn falls_back_to_the_last_user_message() {
        // Consigne réécrite par Claude Code : la réponse au dernier message compte.
        let lines = [user("Ancien"), assistant("Ancienne réponse"), user("Consigne transformée"), assistant("Résumé")];
        assert_eq!(last_reply(&entries(&lines), PROMPT).as_deref(), Some("Résumé"));
    }

    #[test]
    fn reads_summary_from_transcript_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("s.jsonl");
        let lines = [user(PROMPT), assistant("## Objectif\nX")];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let s = read_summary(&path, PROMPT, "Menu mobile", None).unwrap();
        assert_eq!(s.summary, "## Objectif\nX");
        assert!(s.first_message.starts_with("Cette conversation prend la suite de « Menu mobile »"));
        assert!(s.first_message.ends_with("\n\n## Objectif\nX"));
        assert_eq!(read_summary(&tmp.path().join("absent.jsonl"), PROMPT, "X", None), None);
        // Sans titre de parente.
        assert!(first_message("  ", "R", None).starts_with("Cette conversation prend la suite d'une conversation précédente"));
    }

    #[test]
    fn first_message_lists_hub_members() {
        use crate::config::HubRole;
        use crate::hubs::MemberBrief;
        let hub = HandoffContext {
            hub_name: "Refonte".into(),
            role: HubRole::Coordinateur,
            members: vec![
                MemberBrief { title: "Menu".into(), role: HubRole::Executant, messaging_name: Some("site-ab".into()) },
                MemberBrief { title: "Formulaire".into(), role: HubRole::Executant, messaging_name: None },
            ],
        };
        let m = first_message("Coordination", "## Objectif\nX", Some(&hub));
        assert!(m.starts_with("Cette conversation prend la suite de « Coordination »"));
        assert!(m.contains("## Objectif\nX\n\n---\n\nTu fais partie du hub « Refonte »"));
        assert!(m.contains("avec le rôle de coordinateur"));
        assert!(m.contains("- « Menu » (exécutant) — nom de messagerie actuel : `site-ab`"));
        assert!(m.contains("- « Formulaire » (exécutant) — pas lancée en ce moment"));
        assert!(m.contains("SendMessage"));
        // Seul dans son hub : pas de consigne.
        let alone = HandoffContext { members: Vec::new(), ..hub };
        let m = first_message("C", "R", Some(&alone));
        assert!(m.contains("Il n'a pas d'autre membre") && !m.contains("SendMessage"));
        // Hors hub : message inchangé.
        assert!(!first_message("C", "R", None).contains("hub"));
    }

    fn config_with_section() -> Config {
        let mut cfg = Config::default();
        cfg.projects.entry("C--p".into()).or_default().sections.push(Section {
            id: "sec".into(),
            conversation_ids: vec!["avant".into(), "parente".into(), "apres".into()],
            ..Default::default()
        });
        cfg.conversations.insert("parente".into(), ConversationPrefs { color: Some("#dc2626".into()), ..Default::default() });
        cfg
    }

    #[test]
    fn successor_takes_section_color_and_link() {
        let mut cfg = config_with_section();
        apply(&mut cfg, "parente", "suite", 42);
        assert_eq!(cfg.projects["C--p"].sections[0].conversation_ids, vec!["avant", "parente", "suite", "apres"]);
        assert_eq!(cfg.conversations["suite"].color.as_deref(), Some("#dc2626"));
        assert_eq!(cfg.handoff_links["parente"], HandoffLink { successor_id: "suite".into(), at: 42 });
        assert_eq!(successor_of(&cfg, "parente"), Some("suite"));
        assert_eq!(parent_of(&cfg, "suite"), Some("parente"));
        assert_eq!(parent_of(&cfg, "parente"), None);

        // Appliqué deux fois : pas de doublon.
        apply(&mut cfg, "parente", "suite", 43);
        assert_eq!(cfg.projects["C--p"].sections[0].conversation_ids, vec!["avant", "parente", "suite", "apres"]);
    }

    #[test]
    fn unsectioned_parent_without_color() {
        let mut cfg = Config::default();
        // La suite était rangée ailleurs (section choisie à la création) : elle en sort.
        cfg.projects.entry("C--p".into()).or_default().sections.push(Section {
            id: "autre".into(),
            conversation_ids: vec!["suite".into()],
            ..Default::default()
        });
        apply(&mut cfg, "parente", "suite", 1);
        assert!(cfg.projects["C--p"].sections[0].conversation_ids.is_empty());
        assert!(!cfg.conversations.contains_key("suite"));
        assert_eq!(successor_of(&cfg, "parente"), Some("suite"));
    }

    #[test]
    fn archived_parent_keeps_its_place_and_link() {
        let mut cfg = config_with_section();
        apply(&mut cfg, "parente", "suite", 1);
        // La parente archivée : elle n'est plus sur le disque, mais dans les archives.
        cfg.archives.push(ArchiveEntry { session_id: "parente".into(), project_key: "C--p".into(), ..Default::default() });
        let existing: HashSet<String> = ["avant", "apres", "suite"].map(String::from).into();
        assert!(!prune_conversations(&mut cfg, &existing));
        assert_eq!(cfg.projects["C--p"].sections[0].conversation_ids, vec!["avant", "parente", "suite", "apres"]);
        assert_eq!(cfg.conversations["parente"].color.as_deref(), Some("#dc2626"));
        assert_eq!(successor_of(&cfg, "parente"), Some("suite"));

        // Parente mise à la Corbeille depuis les archives : le lien reste tant que la suite existe…
        cfg.archives.clear();
        prune_conversations(&mut cfg, &existing);
        assert_eq!(successor_of(&cfg, "parente"), Some("suite"));
        // …et disparaît avec elle.
        let existing: HashSet<String> = ["avant", "apres"].map(String::from).into();
        assert!(prune_conversations(&mut cfg, &existing));
        assert!(cfg.handoff_links.is_empty());
    }
}
