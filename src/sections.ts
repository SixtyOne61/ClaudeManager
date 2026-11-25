// Sections d'un projet et préférences par conversation : fonctions pures qui renvoient
// une nouvelle configuration (à passer à `updateConfig` dans App.tsx).
//
// Une conversation appartient au plus à une section ; sinon elle est dans la **section par
// défaut** (« Général » tant qu'on ne la renomme pas). Côté données, une conversation de la
// section par défaut n'est listée nulle part (`sectionId = null`) : l'entrée réservée
// `DEFAULT_SECTION_ID` de la liste des sections ne garde que son nom, sa couleur, son repli et
// sa position, et sa liste de conversations reste vide. Absente d'un projet, elle est en tête.
// Les identifiants qui n'existent plus sont retirés par le backend (voir `prune_conversations`
// dans config.rs) ; l'affichage ignore de toute façon les identifiants inconnus.

import type { Config, ConversationPrefs, Section, SessionInfo } from "./api";
import { newId } from "./util";
import { t } from "./i18n";

/** Identifiant réservé de la section par défaut (jamais supprimée). */
export const DEFAULT_SECTION_ID = "default";
/**
 * Nom enregistré de la section par défaut tant qu'on ne la renomme pas. C'est une valeur de
 * la configuration, pas un texte affiché : `sectionName` le traduit à l'affichage.
 */
export const DEFAULT_SECTION_NAME = "Général";

/** Nom affiché d'une section : la section par défaut jamais renommée prend le nom de la langue courante. */
export const sectionName = (section: Section): string =>
  section.id === DEFAULT_SECTION_ID && (!section.name || section.name === DEFAULT_SECTION_NAME) ? t("sidebar.section.defaultName") : section.name;

export const isDefaultSection = (sectionId: string | null | undefined) => !sectionId || sectionId === DEFAULT_SECTION_ID;

/** Identifiant à ranger dans une conversation : `null` pour la section par défaut. */
export const storedSectionId = (sectionId: string | null | undefined): string | null => (isDefaultSection(sectionId) ? null : sectionId!);

/** Sections d'un projet, dans l'ordre d'affichage, section par défaut comprise. */
export function projectSections(cfg: Config, projectKey: string): Section[] {
  const list = cfg.projects[projectKey]?.sections ?? [];
  if (list.some((s) => s.id === DEFAULT_SECTION_ID)) return list;
  const def: Section = { id: DEFAULT_SECTION_ID, name: DEFAULT_SECTION_NAME, color: null, conversationIds: [], collapsed: false };
  return [def, ...list];
}

/** Section par défaut du projet (nom, couleur, repli). */
export const defaultSection = (cfg: Config, projectKey: string): Section =>
  projectSections(cfg, projectKey).find((s) => s.id === DEFAULT_SECTION_ID)!;

/** Remplace les sections d'un projet. */
function withSections(cfg: Config, projectKey: string, sections: Section[]): Config {
  return { ...cfg, projects: { ...cfg.projects, [projectKey]: { ...cfg.projects[projectKey], sections } } };
}

/** Applique une modification à une section. */
function patchSection(cfg: Config, projectKey: string, sectionId: string, patch: Partial<Section>): Config {
  return withSections(
    cfg,
    projectKey,
    projectSections(cfg, projectKey).map((s) => (s.id === sectionId ? { ...s, ...patch } : s)),
  );
}

export function addSection(cfg: Config, projectKey: string, name: string): Config {
  const section: Section = { id: newId(), name, color: null, conversationIds: [], collapsed: false };
  return withSections(cfg, projectKey, [...projectSections(cfg, projectKey), section]);
}

export const renameSection = (cfg: Config, projectKey: string, sectionId: string, name: string) =>
  patchSection(cfg, projectKey, sectionId, { name });

export const setSectionColor = (cfg: Config, projectKey: string, sectionId: string, color: string | null) =>
  patchSection(cfg, projectKey, sectionId, { color });

export const setSectionCollapsed = (cfg: Config, projectKey: string, sectionId: string, collapsed: boolean) =>
  patchSection(cfg, projectKey, sectionId, { collapsed });

/** Supprime une section ; ses conversations retournent dans la section par défaut, qui ne se supprime pas. */
export const deleteSection = (cfg: Config, projectKey: string, sectionId: string) =>
  sectionId === DEFAULT_SECTION_ID ? cfg : withSections(cfg, projectKey, projectSections(cfg, projectKey).filter((s) => s.id !== sectionId));

/** Déplace une section à la place d'une autre. */
export function moveSection(cfg: Config, projectKey: string, sectionId: string, overId: string): Config {
  const list = [...projectSections(cfg, projectKey)];
  const from = list.findIndex((s) => s.id === sectionId);
  const to = list.findIndex((s) => s.id === overId);
  if (from < 0 || to < 0 || from === to) return cfg;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return withSections(cfg, projectKey, list);
}

/**
 * Range une conversation dans une section du projet (`null` ou `DEFAULT_SECTION_ID` = section
 * par défaut). Elle est d'abord retirée de toute autre section, de ce projet comme des autres.
 * Si la section n'existe pas, la conversation reste dans la section par défaut.
 *
 * À utiliser aussi pour une conversation tout juste créée (nouvelle conversation lancée
 * depuis une section).
 */
export function putConversationInSection(cfg: Config, projectKey: string, sectionId: string | null, conversationId: string): Config {
  const projects = { ...cfg.projects };
  for (const [key, prefs] of Object.entries(projects)) {
    const sections = prefs.sections ?? [];
    if (!sections.some((s) => s.conversationIds.includes(conversationId))) continue;
    projects[key] = {
      ...prefs,
      sections: sections.map((s) => ({ ...s, conversationIds: s.conversationIds.filter((id) => id !== conversationId) })),
    };
  }
  let next: Config = { ...cfg, projects };
  if (!isDefaultSection(sectionId) && projectSections(next, projectKey).some((s) => s.id === sectionId)) {
    next = withSections(
      next,
      projectKey,
      projectSections(next, projectKey).map((s) =>
        s.id === sectionId ? { ...s, conversationIds: [...s.conversationIds, conversationId] } : s,
      ),
    );
  }
  return next;
}

/** Section d'une conversation dans un projet, ou `null` (section par défaut). */
export function sectionOf(cfg: Config, projectKey: string, conversationId: string): Section | null {
  return projectSections(cfg, projectKey).find((s) => s.conversationIds.includes(conversationId)) ?? null;
}

/**
 * Répartit des conversations entre les sections, dans l'ordre d'affichage ; la section par
 * défaut reçoit celles qui ne sont rangées nulle part. L'ordre des conversations (le plus
 * récent d'abord) est conservé dans chaque groupe.
 */
export function groupBySection(cfg: Config, projectKey: string, sessions: SessionInfo[]) {
  const sections = projectSections(cfg, projectKey);
  const owner = new Map<string, string>();
  for (const s of sections) for (const id of s.conversationIds) if (!owner.has(id)) owner.set(id, s.id);
  const ownerOf = (id: string) => owner.get(id) ?? DEFAULT_SECTION_ID;
  return { sections: sections.map((section) => ({ section, sessions: sessions.filter((s) => ownerOf(s.id) === section.id) })) };
}

// ---- Préférences par conversation -----------------------------------------------------

export function conversationPrefs(cfg: Config, conversationId: string): ConversationPrefs {
  return cfg.conversations?.[conversationId] ?? {};
}

/** Couleur choisie pour une conversation (liste, onglet de la conversation ouverte…). */
export function conversationColor(cfg: Config, conversationId: string): string | null {
  return conversationPrefs(cfg, conversationId).color ?? null;
}

export function setConversationColor(cfg: Config, conversationId: string, color: string | null): Config {
  const conversations = { ...(cfg.conversations ?? {}) };
  const prefs: ConversationPrefs = { ...conversations[conversationId], color };
  if (!prefs.color) delete prefs.color;
  if (Object.keys(prefs).length === 0) delete conversations[conversationId];
  else conversations[conversationId] = prefs;
  return { ...cfg, conversations };
}
