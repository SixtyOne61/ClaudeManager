// Types et appels au backend Rust (voir src-tauri/src/lib.rs).
// Toutes les opérations sur disque passent par ces fonctions.

import { invoke } from "@tauri-apps/api/core";

export type TitleSource = "custom" | "ai" | "prompt" | "none";

export interface SessionInfo {
  id: string;
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
  archives: ArchiveEntry[];
  showTempProjects: boolean;
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

/** Erreur renvoyée quand une session a été modifiée il y a peu (peut-être ouverte). */
export const ERR_ACTIVE = "SESSION_ACTIVE";

export const api = {
  scan: () => invoke<ScanResult>("scan"),
  searchSessions: (projectKey: string, query: string) =>
    invoke<string[]>("search_sessions", { projectKey, query }),
  searchAll: (query: string) => invoke<SearchResult>("search_all", { query }),
  getConfig: () => invoke<Config>("get_config"),
  saveConfig: (cfg: Config) => invoke<Config>("save_config", { cfg }),
  addProject: (path: string) => invoke<string>("add_project", { path }),
  launchClaude: (path: string, sessionId?: string) =>
    invoke<void>("launch_claude", { path, sessionId: sessionId ?? null }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  archiveSession: (projectKey: string, sessionId: string, force: boolean) =>
    invoke<Config>("archive_session", { projectKey, sessionId, force }),
  restoreArchive: (sessionId: string) => invoke<Config>("restore_archive", { sessionId }),
  trashSession: (projectKey: string, sessionId: string, force: boolean) =>
    invoke<void>("trash_session", { projectKey, sessionId, force }),
  trashArchive: (sessionId: string) => invoke<Config>("trash_archive", { sessionId }),
};

/** Convertit une erreur Tauri (chaîne) ou JS en message lisible. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
