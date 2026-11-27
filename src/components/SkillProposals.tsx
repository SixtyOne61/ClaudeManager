// Propositions de skills (voir src/skills.ts et GLOSSARY.md, « Proposition de skill ») :
// - SkillsDialog      fenêtre « Skills proposés » : propositions au seuil, puis sous le seuil,
//                     avec Créer (portée au choix) et Refuser ; « Plus tard » la ferme ;
// - SkillsReminder    icône 💡 de la barre des onglets quand le rappel est dû (ne s'ouvre
//                     jamais d'elle-même) ;
// - AnalysingBadge    « analyse… » sur une conversation en cours d'analyse de fin.

import { useState } from "react";
import { Lightbulb, Loader2, Plus, X } from "lucide-react";
import type { SkillListing, SkillProposal } from "../api";
import { useAnalysing } from "../skills";
import { Modal } from "./Dialogs";
import { locale, t } from "../i18n";

export function AnalysingBadge({ sessionId }: { sessionId: string }) {
  if (!useAnalysing(sessionId)) return null;
  return (
    <span className="analysing-badge" title={t("skills.analysingTitle")}>
      <Loader2 size={11} className="spin" /> {t("skills.analysing")}
    </span>
  );
}

export function SkillsReminder({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="skills-reminder" onClick={onOpen} title={t("skills.reminderTitle")}>
      <Lightbulb size={14} /> {t("skills.reminder")}
    </button>
  );
}

/** Nom court d'un dossier (dernier élément du chemin). */
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function SkillsDialog(props: {
  listing: SkillListing;
  windowDays: number;
  /** Nom affiché d'un projet d'après son dossier. */
  projectName: (path: string) => string;
  onCreate: (p: SkillProposal, projectScope: boolean) => void;
  onRefuse: (p: SkillProposal) => void;
  onClose: () => void;
}) {
  const { listing } = props;
  const ready = listing.proposals.filter((p) => p.count >= listing.threshold);
  const below = listing.proposals.filter((p) => p.count < listing.threshold);
  const item = (p: SkillProposal) => <ProposalItem key={p.id} proposal={p} projectName={props.projectName} onCreate={props.onCreate} onRefuse={props.onRefuse} />;
  return (
    <Modal title={t("skills.dialog.title")} onClose={props.onClose} className="skills-modal">
      <p className="settings-help">{t("skills.dialog.help", { days: props.windowDays, threshold: listing.threshold })}</p>
      {listing.proposals.length === 0 && <p className="skills-empty">{t("skills.dialog.empty")}</p>}
      {ready.length > 0 && (
        <>
          <h3 className="settings-heading">{t("skills.dialog.ready")}</h3>
          {ready.map(item)}
        </>
      )}
      {below.length > 0 && (
        <>
          <h3 className="settings-heading">{t("skills.dialog.below")}</h3>
          {below.map(item)}
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn primary" onClick={props.onClose}>
          {t("skills.dialog.later")}
        </button>
      </div>
    </Modal>
  );
}

function ProposalItem(props: {
  proposal: SkillProposal;
  projectName: (path: string) => string;
  onCreate: (p: SkillProposal, projectScope: boolean) => void;
  onRefuse: (p: SkillProposal) => void;
}) {
  const p = props.proposal;
  // Portée proposée : le projet si toutes les demandes y ont été faites, sinon l'utilisateur.
  const project = p.projectScope ?? p.latestProject;
  const [projectScope, setProjectScope] = useState(p.projectScope !== null);
  const date = (ms: number) => new Date(ms).toLocaleDateString(locale(), { day: "numeric", month: "short" });
  return (
    <div className="skill-proposal">
      <div className="skill-proposal-head">
        <strong>{p.name}</strong>
        <span className="skill-proposal-count">{t("skills.dialog.count", { count: p.count })}</span>
      </div>
      {p.description && <p className="skill-proposal-desc">{p.description}</p>}
      <ul className="skill-proposal-occurrences">
        {[...p.occurrences].sort((a, b) => b.at - a.at).map((o) => (
          <li key={o.sessionId + o.at}>
            <span className="skill-proposal-meta">
              {date(o.at)} · {props.projectName(o.project) || folderName(o.project)}
            </span>{" "}
            {o.summary || t("skills.dialog.noSummary")}
          </li>
        ))}
      </ul>
      <div className="skill-proposal-actions">
        {project && (
          <label className="settings-inline">
            {t("skills.dialog.scope")}
            <select value={projectScope ? "project" : "user"} onChange={(e) => setProjectScope(e.target.value === "project")}>
              <option value="project">{t("skills.dialog.scopeProject", { name: props.projectName(project) || folderName(project) })}</option>
              <option value="user">{t("skills.dialog.scopeUser")}</option>
            </select>
          </label>
        )}
        <span className="skill-proposal-buttons">
          <button type="button" className="btn small ghost" onClick={() => props.onRefuse(p)} title={t("skills.dialog.refuseTitle")}>
            <X size={13} /> {t("skills.dialog.refuse")}
          </button>
          <button type="button" className="btn small primary" disabled={!project} onClick={() => props.onCreate(p, projectScope)} title={t("skills.dialog.createTitle")}>
            <Plus size={13} /> {t("skills.dialog.create")}
          </button>
        </span>
      </div>
    </div>
  );
}
