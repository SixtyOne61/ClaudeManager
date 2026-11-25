// Limites d'utilisation du forfait (bas de la barre latérale) : fenêtre de 5 heures et
// fenêtre hebdomadaire. Claude Code les passe à la ligne d'état de chaque conversation
// lancée dans l'app (voir src-tauri/src/limits.rs) : elles ne se mettent à jour que
// pendant qu'une conversation tourne ici. Rien n'est demandé au réseau.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, EVT_USAGE_LIMITS, type LimitWindow, type UsageLimits as Limits } from "../api";
import { locale, t } from "../i18n";

/** « 14:30 » le jour même, « lun. 11:00 » sinon (heure locale, langue de l'interface). */
export function formatReset(epochS: number, now = new Date()): string {
  const d = new Date(epochS * 1000);
  const time = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const day = d.toLocaleDateString(locale(), { weekday: "short" });
  return `${day} ${time}`;
}

/** « à l'instant », « il y a 5 min », « il y a 2 h », « il y a 3 j ». */
export function formatAge(atMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, (nowMs - atMs) / 1000);
  if (s < 60) return t("common.justNow");
  if (s < 3600) return t("app.limits.minutesAgo", { count: Math.floor(s / 60) });
  if (s < 86400) return t("app.limits.hoursAgo", { count: Math.floor(s / 3600) });
  return t("app.limits.daysAgo", { count: Math.floor(s / 86400) });
}

/** Couleur de la barre : vert sous 70 %, orange de 70 à 90 %, rouge à partir de 90 %. */
export function level(pct: number): "ok" | "high" | "critical" {
  return pct >= 90 ? "critical" : pct >= 70 ? "high" : "ok";
}

const WEEK_S = 7 * 24 * 3600;

/** Part théorique de la semaine écoulée (0-100) : consommation linéaire, « idéale ». */
export function theoreticalPct(resetsAt: number, nowMs: number): number {
  const elapsed = nowMs / 1000 - (resetsAt - WEEK_S);
  return Math.min(100, Math.max(0, (elapsed / WEEK_S) * 100));
}

function LimitBar({
  label, w, nowMs, compare,
}: { label: string; w: LimitWindow; nowMs: number; compare?: boolean }) {
  const [open, setOpen] = useState(false);
  // Échéance passée : la fenêtre est repartie de zéro (Claude Code ne l'envoie plus).
  const expired = w.resetsAt * 1000 <= nowMs;
  const pct = expired ? 0 : Math.min(100, Math.max(0, w.usedPercentage));
  const shown = Math.round(pct);
  const theo = compare && !expired ? theoreticalPct(w.resetsAt, nowMs) : null;
  const diff = theo === null ? 0 : Math.round(pct - theo);
  return (
    <div className="limit">
      <div className="limit-text">
        <span className="limit-line">
          <span className="limit-label">{t("app.limits.label", { label })}</span> {t("app.limits.percent", { pct: shown })}
          <span className="limit-reset"> · {expired ? t("app.limits.reset") : formatReset(w.resetsAt, new Date(nowMs))}</span>
        </span>
        {theo !== null && (
          <button
            className="limit-plus"
            title={t("app.limits.compareTooltip")}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "−" : "+"}
          </button>
        )}
      </div>
      <div className="limit-track">
        <div className={`limit-bar ${level(pct)}`}>
          <span style={{ width: `${pct}%` }} />
        </div>
        {open && theo !== null && <i className="limit-marker" style={{ left: `${theo}%` }} />}
      </div>
      {open && theo !== null && (
        <div className={`limit-compare ${diff > 0 ? "over" : "under"}`}>
          {diff > 0
            ? t("app.limits.over", { pct: Math.round(theo), diff })
            : diff < 0
              ? t("app.limits.under", { pct: Math.round(theo), diff: -diff })
              : t("app.limits.even", { pct: Math.round(theo) })}
        </div>
      )}
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
    <div className="usage-limits" title={t("app.limits.tooltip")}>
      {hasData ? (
        <>
          {limits.fiveHour && <LimitBar label={t("app.limits.fiveHours")} w={limits.fiveHour} nowMs={nowMs} />}
          {limits.sevenDay && <LimitBar label={t("app.limits.week")} w={limits.sevenDay} nowMs={nowMs} compare />}
          <div className="limit-age">{t("app.limits.updated", { age: formatAge(limits.at, nowMs) })}</div>
        </>
      ) : (
        <div className="limit-empty">{t("app.limits.empty")}</div>
      )}
    </div>
  );
}
