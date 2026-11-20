// « Ouvrir dans Desktop » : rouvre une conversation dans Claude Desktop
// (`claude --desktop --resume <id>`, lancé sans fenêtre par le backend).

import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, type SessionInfo } from "./api";

/** Erreur renvoyée quand le worktree de la conversation n'existe plus. */
export const ERR_WORKTREE_MISSING = "WORKTREE_MISSING";

/**
 * La conversation est-elle ouverte dans un terminal intégré de l'app ?
 * Claude Code refuse de transférer vers Desktop une conversation ouverte ailleurs.
 *
 * TODO(ticket 01, terminal intégré) : brancher ici la liste des terminaux intégrés
 * ouverts, et ajouter la fermeture du terminal dans `openInDesktop` ci-dessous
 * (voir le TODO). Tant que le terminal intégré n'existe pas, toujours faux.
 */
export function isOpenInEmbeddedTerminal(_sessionId: string): boolean {
  return false;
}

interface Deps {
  /** Dossier du projet (repli si celui de la conversation n'existe plus). */
  projectPath: string | null;
  toast: (text: string) => void;
  /** Ouvre la conversation dans un terminal externe (`claude --resume`). */
  openInExternalTerminal: () => void;
}

/** Enchaîne les avertissements puis lance l'ouverture dans Desktop. */
export async function openInDesktop(s: SessionInfo, deps: Deps): Promise<void> {
  if (isOpenInEmbeddedTerminal(s.id)) {
    // TODO(ticket 01) : proposer « Fermer le terminal intégré » puis continuer.
    const ok = await ask(
      "Cette conversation est ouverte dans un terminal intégré. Claude Code refuse de transférer une conversation ouverte ailleurs : fermez d'abord le terminal intégré.\n\nEssayer quand même ?",
      { title: "Conversation ouverte dans l'app", kind: "warning", okLabel: "Essayer quand même", cancelLabel: "Annuler" },
    );
    if (!ok) return;
  }

  const run = (force: boolean) => api.openInDesktop(s.cwd, deps.projectPath, s.id, force);
  try {
    try {
      await run(false);
    } catch (e) {
      const msg = errorMessage(e);
      if (!msg.startsWith(ERR_WORKTREE_MISSING)) throw e;
      const ok = await ask(msg.replace(`${ERR_WORKTREE_MISSING}: `, "") + "\n\nOuvrir dans Desktop quand même ?", {
        title: "Worktree introuvable",
        kind: "warning",
        okLabel: "Ouvrir quand même",
        cancelLabel: "Annuler",
      });
      if (!ok) return;
      await run(true);
    }
    deps.toast("Conversation ouverte dans Claude Desktop");
  } catch (e) {
    // Message de Claude Code tel quel, avec le terminal externe comme solution de repli.
    const fallback = await ask(errorMessage(e), {
      title: "Ouverture dans Desktop impossible",
      kind: "error",
      okLabel: "Ouvrir dans un terminal externe",
      cancelLabel: "Fermer",
    });
    if (fallback) deps.openInExternalTerminal();
  }
}
