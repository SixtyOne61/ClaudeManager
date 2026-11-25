// Sections d'un projet et préférences par conversation : fonctions pures qui renvoient
// une nouvelle configuration (à passer à `updateConfig` dans App.tsx).
//
// Une conversation appartient au plus à une section ; sinon elle est dans la **section par
// défaut** (« Général » tant qu'on ne la renomme pas). Côté données, une conversation de la
// section par défaut n'est listée nulle part (`sectionId = null`) : l'entrée réservée
// `DEFAULT_SECTION_ID` de la liste des sections ne garde que son nom, sa couleur, son repli et
// sa position, et sa liste de conversations reste vide. Absente d'un projet, elle est en tête.
// Les sections s'imbriquent sans limite de profondeur : la liste des sections d'un projet reste
// à plat, `parentId` désigne la section qui contient celle-ci. Un parent inconnu ou un cycle
// est lu comme « premier niveau » (`sectionParents`). Une conversation reste rangée dans une
// seule section, à n'importe quel niveau.
//
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

/**
 * Section parente effective de chaque section (`null` = premier niveau). Un parent inconnu,
 * la section par défaut (toujours au premier niveau) ou un cycle donnent `null`.
 */
export function sectionParents(sections: Section[]): Map<string, string | null> {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const declared = (s: Section): string | null =>
    s.id !== DEFAULT_SECTION_ID && s.parentId && s.parentId !== s.id && byId.has(s.parentId) ? s.parentId : null;
  const parents = new Map<string, string | null>();
  for (const s of sections) {
    // On remonte les parents : si on revient sur une section déjà vue, c'est un cycle et la
    // section remonte au premier niveau.
    const seen = new Set([s.id]);
    let cursor = declared(s);
    let cycle = false;
    while (cursor) {
      if (seen.has(cursor)) {
        cycle = true;
        break;
      }
      seen.add(cursor);
      cursor = declared(byId.get(cursor)!);
    }
    parents.set(s.id, cycle ? null : declared(s));
  }
  return parents;
}

/** Nouvelle section, au premier niveau ou dans `parentId` (sous-section, dépliée pour la voir). */
export function addSection(cfg: Config, projectKey: string, name: string, parentId: string | null = null): Config {
  const section: Section = { id: newId(), name, color: null, conversationIds: [], collapsed: false };
  if (parentId) section.parentId = parentId;
  const next = withSections(cfg, projectKey, [...projectSections(cfg, projectKey), section]);
  return parentId ? expandSection(next, projectKey, parentId) : next;
}

/** Déplie une section et toutes ses ancêtres, pour que son contenu soit visible. */
export function expandSection(cfg: Config, projectKey: string, sectionId: string): Config {
  const sections = projectSections(cfg, projectKey);
  const parents = sectionParents(sections);
  const chain = new Set<string>();
  for (let id: string | null = sectionId; id; id = parents.get(id) ?? null) chain.add(id);
  if (!sections.some((s) => chain.has(s.id) && s.collapsed)) return cfg;
  return withSections(cfg, projectKey, sections.map((s) => (chain.has(s.id) && s.collapsed ? { ...s, collapsed: false } : s)));
}

export const renameSection = (cfg: Config, projectKey: string, sectionId: string, name: string) =>
  patchSection(cfg, projectKey, sectionId, { name });

export const setSectionColor = (cfg: Config, projectKey: string, sectionId: string, color: string | null) =>
  patchSection(cfg, projectKey, sectionId, { color });

export const setSectionCollapsed = (cfg: Config, projectKey: string, sectionId: string, collapsed: boolean) =>
  patchSection(cfg, projectKey, sectionId, { collapsed });

/**
 * Section qui reçoit les conversations et les sous-sections d'une section supprimée : sa
 * section parente, ou la section par défaut au premier niveau.
 */
export function fallbackSection(cfg: Config, projectKey: string, sectionId: string): Section {
  const sections = projectSections(cfg, projectKey);
  const parentId = sectionParents(sections).get(sectionId);
  return sections.find((s) => s.id === parentId) ?? sections.find((s) => s.id === DEFAULT_SECTION_ID)!;
}

/**
 * Supprime une section : ses conversations et ses sous-sections remontent dans sa section
 * parente (la section par défaut au premier niveau). La section par défaut ne se supprime pas.
 */
export function deleteSection(cfg: Config, projectKey: string, sectionId: string): Config {
  if (sectionId === DEFAULT_SECTION_ID) return cfg;
  const sections = projectSections(cfg, projectKey);
  const removed = sections.find((s) => s.id === sectionId);
  if (!removed) return cfg;
  const parent = sectionParents(sections).get(sectionId) ?? null;
  const rest = sections
    .filter((s) => s.id !== sectionId)
    .map((s) => {
      let next = s;
      if (s.parentId === sectionId) next = { ...next, parentId: parent };
      // Au premier niveau, les conversations retournent dans la section par défaut (non listées).
      if (s.id === parent && parent !== DEFAULT_SECTION_ID) {
        next = { ...next, conversationIds: [...next.conversationIds, ...removed.conversationIds] };
      }
      return next;
    });
  return withSections(cfg, projectKey, rest);
}

/**
 * Déplace une section à la place d'une autre du même niveau (même section parente) ;
 * sans effet entre deux niveaux différents.
 */
export function moveSection(cfg: Config, projectKey: string, sectionId: string, overId: string): Config {
  const list = [...projectSections(cfg, projectKey)];
  const parents = sectionParents(list);
  if (parents.get(sectionId) !== parents.get(overId)) return cfg;
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

/** Une section dans l'arbre d'un projet, avec ses conversations propres. */
export interface SectionNode {
  section: Section;
  /** Conversations rangées directement dans cette section. */
  sessions: SessionInfo[];
  /** Niveau d'imbrication : 0 au premier niveau. */
  depth: number;
  /** Section parente effective (`null` au premier niveau). */
  parentId: string | null;
  /** Sous-sections directes, dans l'ordre d'affichage. */
  children: SectionNode[];
  /** Conversations de la section et de toutes ses descendantes. */
  total: number;
  /** Cachée par le repli d'une section ancêtre. */
  hidden: boolean;
}

/**
 * Répartit des conversations entre les sections, dans l'ordre d'affichage ; la section par
 * défaut reçoit celles qui ne sont rangées nulle part. L'ordre des conversations (le plus
 * récent d'abord) est conservé dans chaque groupe.
 *
 * `roots` est l'arbre ; `sections` le même arbre parcouru en profondeur (une section avant
 * ses sous-sections), pour les usages qui n'ont pas besoin de la structure.
 */
export function groupBySection(cfg: Config, projectKey: string, sessions: SessionInfo[]) {
  const list = projectSections(cfg, projectKey);
  const owner = new Map<string, string>();
  for (const s of list) for (const id of s.conversationIds) if (!owner.has(id)) owner.set(id, s.id);
  const ownerOf = (id: string) => owner.get(id) ?? DEFAULT_SECTION_ID;
  const parents = sectionParents(list);
  const nodes = new Map<string, SectionNode>();
  for (const section of list) {
    nodes.set(section.id, {
      section,
      sessions: sessions.filter((s) => ownerOf(s.id) === section.id),
      depth: 0,
      parentId: parents.get(section.id) ?? null,
      children: [],
      total: 0,
      hidden: false,
    });
  }
  const roots: SectionNode[] = [];
  for (const section of list) {
    const node = nodes.get(section.id)!;
    (node.parentId ? nodes.get(node.parentId)!.children : roots).push(node);
  }
  const flat: SectionNode[] = [];
  const walk = (node: SectionNode, depth: number, hidden: boolean) => {
    node.depth = depth;
    node.hidden = hidden;
    flat.push(node);
    node.total = node.sessions.length;
    for (const child of node.children) {
      walk(child, depth + 1, hidden || node.section.collapsed);
      node.total += child.total;
    }
  };
  for (const root of roots) walk(root, 0, false);
  return { roots, sections: flat };
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
