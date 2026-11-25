// Hubs (voir GLOSSARY.md, « Hubs », et src-tauri/src/hubs.rs) : des conversations,
// éventuellement de projets différents, qui travaillent ensemble. Une conversation reste
// rangée dans son projet ; le hub n'y fait que renvoyer (icône 🔗).
//
// Les hubs sont gérés par le backend (règles testées côté Rust) : on les modifie avec les
// commandes `api.hub*` (création, nom et couleur, membres et rôles, archivage, suppression),
// jamais avec `saveConfig`. Ce module ne fait que les lire :
// - activeHubs(cfg)            hubs affichés dans la barre latérale (non archivés)
// - archivedHubs(cfg)          hubs archivés (vue Archives)
// - hubOf(cfg, id)             hub d'une conversation et son rôle
// - coordinatorOf(hub)         coordinateur du hub, s'il en a un
// - defaultRole(hub)           rôle d'une conversation ajoutée par glisser-déposer
// - sortedMembers(hub)         membres, coordinateur en tête
// - HUB_ROLES, roleLabel()     libellés des rôles (roleHint() : leur explication)
// - executorFirstMessage()     premier message d'un exécutant lancé avec « + Exécutant »

import type { Config, Hub, HubMember, HubRole } from "./api";
import { t, type MessageKey } from "./i18n";

/** Rôles, dans l'ordre des choix proposés. */
export const HUB_ROLES: HubRole[] = ["coordinateur", "executant", "pair"];

const ROLE_LABELS: Record<HubRole, MessageKey> = { coordinateur: "hubs.role.coordinateur", executant: "hubs.role.executant", pair: "hubs.role.pair" };

const ROLE_HINTS: Record<HubRole, MessageKey> = {
  coordinateur: "hubs.role.hint.coordinateur",
  executant: "hubs.role.hint.executant",
  pair: "hubs.role.hint.pair",
};

/** Libellé d'un rôle (« Coordinateur », « Exécutant », « Pair »). */
export function roleLabel(role: HubRole): string {
  const key = ROLE_LABELS[role];
  return key ? t(key) : role;
}

/** Explication courte d'un rôle (fenêtre « Ajouter à un hub… »). */
export function roleHint(role: HubRole): string {
  const key = ROLE_HINTS[role];
  return key ? t(key) : "";
}

/** Hubs affichés dans la barre latérale, dans l'ordre enregistré. */
export function activeHubs(cfg: Config): Hub[] {
  return (cfg.hubs ?? []).filter((h) => !h.archived);
}

/** Hubs archivés, du plus récent au plus ancien. */
export function archivedHubs(cfg: Config): Hub[] {
  return (cfg.hubs ?? []).filter((h) => h.archived).sort((a, b) => b.archived!.archivedAt - a.archived!.archivedAt);
}

/** Hub d'une conversation et son rôle (une conversation est dans un hub au plus). */
export function hubOf(cfg: Config, conversationId: string): { hub: Hub; role: HubRole } | null {
  for (const hub of cfg.hubs ?? []) {
    const m = hub.members.find((x) => x.conversationId === conversationId);
    if (m) return { hub, role: m.role };
  }
  return null;
}

/** Coordinateur du hub, s'il en a un. */
export function coordinatorOf(hub: Hub): HubMember | null {
  return hub.members.find((m) => m.role === "coordinateur") ?? null;
}

/** Rôle d'une conversation ajoutée sans choix explicite : exécutant s'il y a un coordinateur, sinon pair. */
export function defaultRole(hub: Hub): HubRole {
  return coordinatorOf(hub) ? "executant" : "pair";
}

/** Membres, coordinateur en tête (ordre d'ajout sinon). */
export function sortedMembers(hub: Hub): HubMember[] {
  return [...hub.members].sort((a, b) => Number(b.role === "coordinateur") - Number(a.role === "coordinateur"));
}

/** Info-bulle de l'icône 🔗 d'une conversation membre. */
export function hubHint(hub: Hub, role: HubRole): string {
  return t("hubs.link.hint", { name: hub.name, role: roleLabel(role), archived: hub.archived ? "yes" : "no" });
}

/** Explication du bouton « + Exécutant » grisé (hub sans coordinateur) ; null : disponible. */
export function executorBlocker(hub: Hub): string | null {
  return coordinatorOf(hub) ? null : t("hubs.executor.blocker");
}

/**
 * Premier message d'un exécutant lancé avec « + Exécutant » : la tâche, puis qui est son
 * coordinateur et la consigne de lui rendre compte. `coordinator.messagingName` : nom de
 * messagerie actuel du coordinateur (null s'il ne tourne pas : seul le titre de sa
 * conversation est cité).
 */
export function executorFirstMessage(task: string, hubName: string, coordinator: { messagingName: string | null; title: string }): string {
  const who = coordinator.messagingName ? `\`${coordinator.messagingName}\`` : `« ${coordinator.title} »`;
  return (
    `${task.trim()}\n\n` +
    `Tu es un exécutant du hub « ${hubName} ». Ton coordinateur est la conversation ${who}. ` +
    "Quand tu as fini (ou si tu es bloqué), envoie-lui un compte rendu avec l'outil SendMessage."
  );
}
