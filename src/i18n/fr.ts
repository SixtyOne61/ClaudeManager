// Catalogue de référence (français), découpé par zone de l'interface. Chaque fichier préfixe
// ses clés par sa zone (`sidebar.…`, `project.…`) : deux fichiers ne partagent aucune clé
// (vérifié par scripts/i18n-check.mjs).

import common from "./fr/common";
import app from "./fr/app";
import project from "./fr/project";
import sidebar from "./fr/sidebar";
import hubs from "./fr/hubs";
import conversation from "./fr/conversation";
import settings from "./fr/settings";
import suggestions from "./fr/suggestions";
import slash from "./fr/slash";
import tools from "./fr/tools";
import handoff from "./fr/handoff";
import errors from "./fr/errors";

export const FR = {
  ...common,
  ...app,
  ...project,
  ...sidebar,
  ...hubs,
  ...conversation,
  ...settings,
  ...suggestions,
  ...slash,
  ...tools,
  ...handoff,
  ...errors,
} as const;

export type MessageKey = keyof typeof FR;
