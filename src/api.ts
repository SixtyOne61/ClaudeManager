// Types et appels au backend Rust (voir src-tauri/src/lib.rs).
// Toutes les opérations sur disque passent par ces fonctions.

import { invoke } from "@tauri-apps/api/core";

export type TitleSource = "custom" | "ai" | "prompt" | "none";

/** Worktree (`<projet>\.claude\worktrees\<nom>`) dans lequel tourne une conversation. */
export interface WorktreeInfo {
  name: string;
  /** Dossier du worktree : c'est là que `claude --resume` doit être lancé. */
  path: string;
  exists: boolean;
}

export interface SessionInfo {
  id: string;
  /** Dossier où est rangé le fichier (clé de stockage) ; pour un worktree, différent du projet affiché. */
  projectKey: string;
  cwd: string | null;
  title: string;
  titleSource: TitleSource;
  firstPrompt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  fileSize: number;
  modifiedMs: number;
  skippedLines: number;
  /** Conversation d'un worktree, rangée sous son projet parent. */
  worktree?: WorktreeInfo | null;
  /**
   * Interface uniquement : nouvelle conversation lancée dans le terminal intégré dont le
   * fichier n'existe pas encore (titre provisoire « Nouvelle conversation »).
   */
  provisional?: boolean;
}

export interface ProjectInfo {
  /** Nom du dossier encodé dans ~/.claude/projects (clé stable). */
  key: string;
  path: string | null;
  exists: boolean;
  isTemp: boolean;
  lastActivity: string | null;
  /** Triées de la plus récente à la plus ancienne. */
  sessions: SessionInfo[];
}

export interface ScanResult {
  projects: ProjectInfo[];
  terminal: string;
  claudeRoot: string;
  appDir: string;
}

export interface Category {
  id: string;
  name: string;
  color: string | null;
  projectKeys: string[];
}

export interface ProjectPrefs {
  displayName?: string | null;
  color?: string | null;
  path?: string | null;
  /** Sections du projet, dans l'ordre d'affichage (absent dans un vieux fichier). */
  sections?: Section[];
  /** Projet archivé : masqué de la barre latérale, ses conversations sont dans les archives. */
  archived?: ProjectArchive | null;
}

/** Archivage d'un projet entier (le dossier n'est pas touché). */
export interface ProjectArchive {
  archivedAt: number;
  /** Conversations archivées avec le projet, restaurées avec lui. */
  sessionIds: string[];
}

/** Résultat de la restauration d'un projet archivé. */
export interface RestoreProjectResult {
  config: Config;
  restored: number;
  /** Conversations restées dans les archives, avec la raison. */
  errors: string[];
}

/** Regroupement de conversations à l'intérieur d'un projet (voir src/sections.ts). */
export interface Section {
  id: string;
  name: string;
  color: string | null;
  /** Conversations de la section ; une conversation archivée y reste. */
  conversationIds: string[];
  collapsed: boolean;
}

/** Préférences d'une conversation, conservées à l'archivage. */
export interface ConversationPrefs {
  color?: string | null;
  /** Suggestions ignorées, par clé de suggestion (voir src/suggestions.ts). */
  dismissedSuggestions?: Record<string, Dismissal>;
}

/** « Ignorer » sur une suggestion : masquée jusqu'à un palier plus élevé (voir suggestions.rs). */
export interface Dismissal {
  /** Palier ignoré. */
  level: number;
  /** Moment du clic (ms depuis 1970). */
  at: number;
}

/** Réglages des suggestions. */
export interface SuggestionSettings {
  /** Règles coupées (identifiants de règle). */
  disabled: string[];
  /** Seuil de la règle « Contexte rempli », en pourcentage. */
  contextThreshold: number;
}

/** Lien d'un hand off, rangé sous l'identifiant de la parente (voir src/handoff.ts). */
export interface HandoffLink {
  /** Conversation qui a pris le relais. */
  successorId: string;
  /** Moment du hand off (ms depuis 1970). */
  at: number;
}

/** Résumé de passation lu dans la parente, et premier message de la suite (voir handoff.rs). */
export interface HandoffSummary {
  summary: string;
  firstMessage: string;
}

/** Fin d'un hand off : configuration à jour, et erreur si la parente n'a pas pu être archivée. */
export interface HandoffFinish {
  config: Config;
  archiveError: string | null;
}

export interface ArchiveEntry {
  sessionId: string;
  projectKey: string;
  projectPath: string | null;
  title: string;
  messageCount: number;
  updatedAt: string | null;
  archivedAt: number;
  originalFile: string;
  originalDir: string | null;
  archivedFile: string;
  archivedDir: string | null;
}

export interface Config {
  version: number;
  categories: Category[];
  projects: Record<string, ProjectPrefs>;
  /** Préférences par identifiant de conversation. */
  conversations: Record<string, ConversationPrefs>;
  archives: ArchiveEntry[];
  showTempProjects: boolean;
  /** Réglages des suggestions (absent dans un vieux fichier). */
  suggestions?: SuggestionSettings;
  /** Hand off : suite de chaque parente, par identifiant de la parente. Géré par le backend. */
  handoffLinks?: Record<string, HandoffLink>;
  /** Consigne du résumé de passation choisie dans les réglages (absente : texte par défaut). */
  handoffPrompt?: string | null;
}

/** Extrait d'un message découpé autour du mot trouvé. */
export interface SearchExcerpt {
  before: string;
  matched: string;
  after: string;
}

/** Un message qui contient la recherche. */
export interface SearchHit {
  role: "user" | "assistant";
  /** Numéro de la ligne dans le .jsonl (à partir de 0). */
  line: number;
  /** Identifiant de la ligne (plus stable que son numéro). */
  uuid: string | null;
  excerpt: SearchExcerpt;
}

/** Une conversation qui contient la recherche. */
export interface SessionHits {
  projectKey: string;
  projectPath: string | null;
  sessionId: string;
  title: string;
  updatedAt: string | null;
  archived: boolean;
  /** Nombre de messages trouvés (seuls les premiers ont un extrait). */
  matchCount: number;
  hits: SearchHit[];
}

export interface SearchResult {
  /** De la plus récente à la plus ancienne. */
  sessions: SessionHits[];
  truncated: boolean;
  /** Interrompue par une recherche plus récente : à ignorer. */
  cancelled: boolean;
  elapsedMs: number;
}

/** Une fenêtre de limite d'utilisation du forfait (voir src-tauri/src/limits.rs). */
export interface LimitWindow {
  /** Part consommée, de 0 à 100. */
  usedPercentage: number;
  /** Remise à zéro, en secondes depuis 1970. */
  resetsAt: number;
}

/** Limites d'utilisation (fenêtre de 5 h, fenêtre hebdomadaire), relevées par la ligne d'état. */
export interface UsageLimits {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  /** Dernière mise à jour (ms depuis 1970). */
  at: number;
}

/** Évènement émis quand `limits.json` change (charge utile : UsageLimits). */
export const EVT_USAGE_LIMITS = "usage-limits";

/** Erreur renvoyée quand une session a été modifiée il y a peu (peut-être ouverte). */
export const ERR_ACTIVE = "SESSION_ACTIVE";

export const api = {
  scan: () => invoke<ScanResult>("scan"),
  searchSessions: (projectKey: string, query: string) =>
    invoke<string[]>("search_sessions", { projectKey, query }),
  searchAll: (query: string) => invoke<SearchResult>("search_all", { query }),
  getConfig: () => invoke<Config>("get_config"),
  saveConfig: (cfg: Config) => invoke<Config>("save_config", { cfg }),
  /** `language` : langue des réponses de Claude dans ce projet (null = inchangée). */
  addProject: (path: string, language: string | null) => invoke<string>("add_project", { path, language }),
  launchClaude: (path: string, sessionId?: string) =>
    invoke<void>("launch_claude", { path, sessionId: sessionId ?? null }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  /** Le dossier est-il la racine d'un dépôt git (option « Dans un nouveau worktree ») ? */
  isGitRepo: (path: string) => invoke<boolean>("is_git_repo", { path }),
  archiveSession: (projectKey: string, sessionId: string, force: boolean) =>
    invoke<Config>("archive_session", { projectKey, sessionId, force }),
  restoreArchive: (sessionId: string) => invoke<Config>("restore_archive", { sessionId }),
  /** Marque un projet comme archivé, une fois ses conversations archivées. */
  markProjectArchived: (projectKey: string, sessionIds: string[]) =>
    invoke<Config>("mark_project_archived", { projectKey, sessionIds }),
  /** Restaure un projet archivé et les conversations archivées avec lui. */
  restoreProject: (projectKey: string) => invoke<RestoreProjectResult>("restore_project", { projectKey }),
  trashSession: (projectKey: string, sessionId: string, force: boolean) =>
    invoke<void>("trash_session", { projectKey, sessionId, force }),
  trashArchive: (sessionId: string) => invoke<Config>("trash_archive", { sessionId }),
  /**
   * Erreur `SESSION_ACTIVE` si la conversation a été modifiée il y a moins de 2 minutes par
   * un autre programme. `releasedAt` : fermeture (ms) du terminal intégré de l'app pour elle.
   */
  checkOpenElsewhere: (projectKey: string, sessionId: string, releasedAt: number | null) =>
    invoke<void>("check_open_elsewhere", { projectKey, sessionId, releasedAt }),
  /**
   * Hand off : réponse de la parente à la consigne du résumé de passation, lue dans son
   * `.jsonl`, et premier message de la suite (null : réponse vide ou introuvable).
   */
  handoffSummary: (sessionId: string, cwd: string | null, prompt: string, parentTitle: string) =>
    invoke<HandoffSummary | null>("handoff_summary", { sessionId, cwd, prompt, parentTitle }),
  /**
   * Hand off, dernière étape : section, couleur et lien pour la suite, archivage de la parente.
   * `projectKey` : dossier de stockage de la parente.
   */
  handoffFinish: (projectKey: string, parentId: string, successorId: string) =>
    invoke<HandoffFinish>("handoff_finish", { projectKey, parentId, successorId }),
  /** Dernières limites d'utilisation connues (null : aucune encore). */
  usageLimits: () => invoke<UsageLimits | null>("usage_limits"),
};

/** Convertit une erreur Tauri (chaîne) ou JS en message lisible. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
