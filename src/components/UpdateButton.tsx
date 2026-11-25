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
import { t } from "../i18n";

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
        await message(version ? t("app.update.upToDateVersion", { version }) : t("app.update.upToDate"), { title: t("app.update.title") });
        return;
      }
      const notes = update.body?.trim() ? `\n\n${update.body.trim()}` : "";
      const ok = await ask(t("app.update.available", { version: update.version, current: update.currentVersion, notes }), {
        title: t("app.update.availableTitle"),
        okLabel: t("app.update.install"),
        cancelLabel: t("app.update.later"),
      });
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
      await message(t("app.update.failed", { message: errorMessage(e) }), {
        title: t("app.update.title"),
        kind: "error",
      });
    } finally {
      setState({ kind: "idle" });
    }
  };

  const busy = state.kind !== "idle";
  const label =
    state.kind === "checking"
      ? t("app.update.checking")
      : state.kind === "downloading"
        ? state.percent !== null
          ? t("app.update.downloadingPercent", { percent: state.percent })
          : t("app.update.downloading")
        : t("app.update.check");

  return (
    <button className="nav-item small" onClick={run} disabled={busy} title={t("app.update.checkTooltip")}>
      {state.kind === "downloading" ? <Download size={14} /> : <RefreshCw size={14} className={busy ? "spin" : ""} />}
      {label}
      {version && <span className="count">v{version}</span>}
    </button>
  );
}
