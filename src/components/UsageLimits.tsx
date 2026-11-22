// Limites d'utilisation du forfait (bas de la barre latérale) : fenêtre de 5 heures et
// fenêtre hebdomadaire. Claude Code les passe à la ligne d'état de chaque conversation
// lancée dans l'app (voir src-tauri/src/limits.rs) : elles ne se mettent à jour que
// pendant qu'une conversation tourne ici. Rien n'est demandé au réseau.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, EVT_USAGE_LIMITS, type LimitWindow, type UsageLimits as Limits } from "../api";

const TOOLTIP =
  "Limites d'utilisation de ton forfait Claude (Pro, Max), telles que Claude Code les reçoit.\n" +
  "Les chiffres ne se mettent à jour que pendant qu'une conversation tourne dans l'app.";

/** « 14:30 » le jour même, « lun. 11:00 » sinon (heure locale). */
export function formatReset(epochS: number, now = new Date()): string {
  const d = new Date(epochS * 1000);
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const day = d.toLocaleDateString("fr-FR", { weekday: "short" });
  return `${day} ${time}`;
}

/** « à l'instant », « il y a 5 min », « il y a 2 h », « il y a 3 j ». */
export function formatAge(atMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, (nowMs - atMs) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

/** Niveau de couleur : orange au-delà de 80 %, rouge à partir de 95 %. */
export function level(pct: number): "" | "high" | "critical" {
  return pct >= 95 ? "critical" : pct > 80 ? "high" : "";
}

function LimitBar({ label, w, nowMs }: { label: string; w: LimitWindow; nowMs: number }) {
  // Échéance passée : la fenêtre est repartie de zéro (Claude Code ne l'envoie plus).
  const expired = w.resetsAt * 1000 <= nowMs;
  const pct = expired ? 0 : Math.min(100, Math.max(0, w.usedPercentage));
  const shown = Math.round(pct);
  return (
    <div className="limit">
      <div className="limit-text">
        <span className="limit-label">{label} :</span> {shown} %
        <span className="limit-reset"> · {expired ? "remis à zéro" : formatReset(w.resetsAt, new Date(nowMs))}</span>
      </div>
      <div className={`limit-bar ${level(pct)}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function UsageLimits() {
  const [limits, setLimits] = useState<Limits | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    api.usageLimits().then((l) => alive && l && setLimits(l), () => {});
    const unlisten = listen<Limits>(EVT_USAGE_LIMITS, (e) => setLimits(e.payload));
    // Rafraîchit « il y a X min » et les fenêtres arrivées à échéance.
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => setNowMs(Date.now()), [limits]);

  const hasData = limits && (limits.fiveHour || limits.sevenDay);
  return (
    <div className="usage-limits" title={TOOLTIP}>
      {hasData ? (
        <>
          {limits.fiveHour && <LimitBar label="5 h" w={limits.fiveHour} nowMs={nowMs} />}
          {limits.sevenDay && <LimitBar label="Semaine" w={limits.sevenDay} nowMs={nowMs} />}
          <div className="limit-age">mis à jour {formatAge(limits.at, nowMs)}</div>
        </>
      ) : (
        <div className="limit-empty">Lance une conversation pour voir tes limites</div>
      )}
    </div>
  );
}
