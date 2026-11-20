// Bouton « Vérifier les mises à jour » (bas de la barre latérale).
// Aucune connexion n'est faite tant que l'utilisateur ne clique pas : on interroge alors
// le latest.json de la dernière release GitHub, puis on demande avant de télécharger.
// L'installateur est signé et vérifié par le plugin ; sous Windows, l'appli se ferme
// pendant l'installation puis l'installateur la relance.

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { Download, RefreshCw } from "lucide-react";
import { errorMessage } from "../api";

type State = { kind: "idle" } | { kind: "checking" } | { kind: "downloading"; percent: number | null };

export function UpdateButton() {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    getVersion().then(setVersion, () => setVersion(null));
  }, []);

  const run = async () => {
    setState({ kind: "checking" });
    try {
      const update = await check();
      if (!update) {
        await message(`Vous utilisez la dernière version${version ? ` (${version})` : ""}.`, { title: "Mises à jour" });
        return;
      }
      const notes = update.body?.trim() ? `\n\n${update.body.trim()}` : "";
      const ok = await ask(
        `La version ${update.version} est disponible (actuelle : ${update.currentVersion}).${notes}\n\n` +
          "Télécharger et installer maintenant ? L'application se fermera pendant l'installation.",
        { title: "Mise à jour disponible", okLabel: "Installer", cancelLabel: "Plus tard" },
      );
      if (!ok) return;

      let total = 0;
      let received = 0;
      setState({ kind: "downloading", percent: null });
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          received += e.data.chunkLength;
          setState({ kind: "downloading", percent: total ? Math.round((received / total) * 100) : null });
        }
      });
    } catch (e) {
      await message(`Impossible de vérifier ou d'installer la mise à jour :\n${errorMessage(e)}`, {
        title: "Mises à jour",
        kind: "error",
      });
    } finally {
      setState({ kind: "idle" });
    }
  };

  const busy = state.kind !== "idle";
  const label =
    state.kind === "checking"
      ? "Vérification…"
      : state.kind === "downloading"
        ? `Téléchargement${state.percent !== null ? ` ${state.percent} %` : "…"}`
        : "Vérifier les mises à jour";

  return (
    <button className="nav-item small" onClick={run} disabled={busy} title="Interroge GitHub pour savoir si une nouvelle version existe">
      {state.kind === "downloading" ? <Download size={14} /> : <RefreshCw size={14} className={busy ? "spin" : ""} />}
      {label}
      {version && <span className="count">v{version}</span>}
    </button>
  );
}
