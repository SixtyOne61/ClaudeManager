// Pied de la conversation, comme dans Claude Desktop : modèle, mode de permission et contexte
// utilisé, lus dans le `.jsonl` (voir `conversation::Meta`).
//
// - Modèle : clic → petit menu de choix ; `/model <alias>` est envoyé au terminal sans le faire
//   remonter ; si Claude Code demande une confirmation (« Switch model? » en cours de
//   conversation), elle est reprise dans la conversation (voir ConfirmCard). Claude Code n'écrit le nouveau modèle dans le `.jsonl` (réponse, annonce) qu'au
//   message suivant, mais tout de suite la sortie « Set model to … » : elle sert d'affichage.
// - Mode : clic → Maj+Tab (ESC [ Z) envoyé au terminal, qui passe au mode suivant. Claude Code
//   n'écrit le mode dans le `.jsonl` qu'avec le message suivant : le nouveau mode est donc lu
//   dans la sortie du terminal (« ⏵⏵ accept edits on (shift+tab to cycle) »). S'il n'y est pas
//   reconnu, le badge l'indique (« visible au prochain message »).
// - Contexte : entrée + cache écrit + cache lu de la dernière réponse, rapportés à la fenêtre
//   de contexte du modèle quand elle est connue.

import { useEffect, useRef, useState } from "react";
import { Check, Cpu, ShieldCheck } from "lucide-react";
import type { ConversationMeta } from "../conversation";
import { watchPtyOutput, writeToTerminal } from "../pty";
import { locale, t } from "../i18n";

interface Props {
  sessionId: string;
  meta: ConversationMeta;
  /** Début de la conversation non lu (gros fichier) : la somme des jetons produits est partielle. */
  headSkipped: boolean;
  /** `claude` tourne dans le terminal : les clics peuvent lui envoyer des touches. */
  enabled: boolean;
  /** Envoie une commande `/…` comme la zone de saisie (le terminal remonte). */
  onCommand: (text: string, opts?: { quiet?: boolean }) => Promise<void>;
}

// ---- Modèle ----------------------------------------------------------------------------

/** « claude-opus-5-5 » → « Opus 5.5 », « claude-opus-5[1m] » → « Opus 5 (1M) ». */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id);
  if (!m) return id.replace(/^claude-/, "");
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}${m[3] ? "." + m[3] : ""}${m[4] ? " (1M)" : ""}`;
}

/**
 * Fenêtre de contexte (en jetons), d'après la documentation de l'API Claude (tableau des
 * modèles, novembre 2026) : 1 M pour Fable / Mythos, Opus et Sonnet à partir de 4.6, Haiku à
 * partir de 5 ; 200 k pour les modèles plus anciens (Haiku 4.5, Opus / Sonnet 4.5…) ; 1 M pour
 * une variante `[1m]`. Inconnue : null (le pourcentage n'est pas affiché).
 */
export function contextWindow(id: string): number | null {
  if (/\[1m\]$/i.test(id)) return 1_000_000;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(id);
  if (!m) return null;
  const family = m[1].toLowerCase();
  const version = Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
  switch (family) {
    case "fable":
    case "mythos":
      return 1_000_000;
    case "opus":
    case "sonnet":
      return version >= 4.6 ? 1_000_000 : version >= 4 ? 200_000 : null;
    case "haiku":
      return version >= 5 ? 1_000_000 : version >= 4 ? 200_000 : null;
    default:
      return null;
  }
}

/** Choix du menu : argument de `/model`, libellé (lu à l'affichage). */
const MODEL_CHOICES: { arg: string; label: () => string; family: string | null; oneM: boolean }[] = [
  { arg: "default", label: () => t("conversation.footer.modelDefault"), family: null, oneM: false },
  { arg: "opus", label: () => "Opus", family: "opus", oneM: false },
  { arg: "sonnet", label: () => "Sonnet", family: "sonnet", oneM: false },
  { arg: "haiku", label: () => "Haiku", family: "haiku", oneM: false },
  { arg: "opus[1m]", label: () => t("conversation.footer.modelOpus1m"), family: "opus", oneM: true },
  { arg: "sonnet[1m]", label: () => t("conversation.footer.modelSonnet1m"), family: "sonnet", oneM: true },
];

/** « Sonnet 5.5 (1M context) » → « claude-sonnet-5-5[1m] » (pour la fenêtre de contexte). */
export function modelIdFromName(name: string): string | null {
  const m = /^([A-Za-z]+) (\d+)(?:\.(\d+))?( \(1M.*\))?$/.exec(name.trim());
  if (!m) return null;
  return `claude-${m[1].toLowerCase()}-${m[2]}${m[3] ? "-" + m[3] : ""}${m[4] ? "[1m]" : ""}`;
}

/** Modèle affiché : le dernier changement par `/model` s'il est plus récent que la dernière
 *  réponse ou annonce ; sinon l'annonce de Claude Code (nom lisible, `[1m]`) si elle porte sur
 *  le même modèle que la dernière réponse, sinon le modèle de la dernière réponse. */
function currentModel(meta: ConversationMeta): { id: string; name: string } | null {
  const sw = meta.modelSwitch;
  if (sw && (meta.modelLine == null || sw.line > meta.modelLine)) {
    return { id: modelIdFromName(sw.name) ?? sw.name, name: sw.name };
  }
  const ident = meta.modelIdentity;
  const sameAsLast = ident && (!meta.model || ident.id.replace(/\[1m\]$/i, "") === meta.model);
  if (ident && sameAsLast) return { id: ident.id, name: modelLabel(ident.id) };
  if (meta.model) return { id: meta.model, name: modelLabel(meta.model) };
  return null;
}

// ---- Mode de permission ----------------------------------------------------------------

/** Modes de Claude Code (https://code.claude.com/docs/en/permissions) : libellé et couleur. */
function modeInfo(id: string): { label: string; tone: string; hint: string } | null {
  switch (id) {
    case "default":
      return { label: t("conversation.footer.mode.default"), tone: "normal", hint: t("conversation.footer.mode.default.hint") };
    case "acceptEdits":
      return { label: t("conversation.footer.mode.acceptEdits"), tone: "edits", hint: t("conversation.footer.mode.acceptEdits.hint") };
    case "plan":
      return { label: t("conversation.footer.mode.plan"), tone: "plan", hint: t("conversation.footer.mode.plan.hint") };
    case "auto":
      return { label: t("conversation.footer.mode.auto"), tone: "auto", hint: t("conversation.footer.mode.auto.hint") };
    case "bypassPermissions":
      return { label: t("conversation.footer.mode.bypassPermissions"), tone: "danger", hint: t("conversation.footer.mode.bypassPermissions.hint") };
    case "dontAsk":
      return { label: t("conversation.footer.mode.dontAsk"), tone: "dontask", hint: t("conversation.footer.mode.dontAsk.hint") };
    default:
      return null;
  }
}

/** Indicateur affiché par Claude Code sous sa zone de saisie → mode. */
const INDICATORS: [RegExp, string][] = [
  [/accept edits/i, "acceptEdits"],
  [/plan mode/i, "plan"],
  [/auto mode/i, "auto"],
  [/bypass permissions/i, "bypassPermissions"],
  [/don.t ask/i, "dontAsk"],
  [/manual mode/i, "default"],
];
const INDICATOR_RE = /(accept edits|plan mode|auto mode|bypass permissions|don.t ask|manual mode) on\s*\(shift\+tab/gi;
/** Après un Maj+Tab, l'absence d'indicateur avec « ? for shortcuts » signifie le mode normal. */
const SHORTCUTS_RE = /\? for shortcuts/i;
/** Durée pendant laquelle la sortie du terminal est attribuée au Maj+Tab envoyé. */
const CYCLE_WINDOW_MS = 2500;

/** Texte brut d'une sortie de terminal (séquences d'échappement retirées, déplacements → espace). */
function plainText(data: string): string {
  return data
    .replace(/\x1b\[\d*C/g, " ")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** Dernier mode annoncé par le terminal dans `text`, ou null. */
export function modeFromTerminal(text: string): string | null {
  const all = [...plainText(text).matchAll(INDICATOR_RE)];
  const last = all[all.length - 1]?.[1];
  if (!last) return null;
  return INDICATORS.find(([re]) => re.test(last))?.[1] ?? null;
}

// ---- Contexte --------------------------------------------------------------------------

const nbsp = " ";
function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 1 })}${nbsp}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}${nbsp}k`;
  return String(n);
}
const exact = (n: number) => n.toLocaleString(locale());

// ---- Composant -------------------------------------------------------------------------

export function ConversationFooter({ sessionId, meta, headSkipped, enabled, onCommand }: Props) {
  // Mode lu dans le terminal, avec la ligne du dernier mode enregistré à ce moment-là : il
  // vaut jusqu'à ce que le `.jsonl` enregistre un mode plus récent.
  const [fromTerminal, setFromTerminal] = useState<{ mode: string; line: number | null } | null>(null);
  /** Maj+Tab envoyé, nouveau mode pas encore reconnu. */
  const [pending, setPending] = useState(false);
  const cycleAt = useRef(0);
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const buffer = useRef("");
  const lineRef = useRef(meta.permissionModeLine);
  lineRef.current = meta.permissionModeLine;

  // Lecture de l'indicateur de mode dans la sortie du terminal (toujours, pour suivre aussi
  // un Maj+Tab tapé directement dans le terminal).
  useEffect(() => {
    buffer.current = "";
    const stop = watchPtyOutput(sessionId, (data) => {
      buffer.current = (buffer.current + data).slice(-6000);
      let mode = modeFromTerminal(buffer.current);
      const inWindow = Date.now() - cycleAt.current < CYCLE_WINDOW_MS;
      if (!mode && inWindow && SHORTCUTS_RE.test(plainText(buffer.current))) mode = "default";
      if (!mode) return;
      buffer.current = "";
      clearTimeout(pendingTimer.current);
      setFromTerminal({ mode, line: lineRef.current });
      setPending(false);
    });
    return () => {
      stop();
      clearTimeout(pendingTimer.current);
    };
  }, [sessionId]);

  // Nouveau mode enregistré dans le `.jsonl` : il remplace ce qui avait été lu dans le terminal.
  useEffect(() => {
    clearTimeout(pendingTimer.current);
    setPending(false);
  }, [meta.permissionModeLine]);

  const terminalMode = fromTerminal && fromTerminal.line === meta.permissionModeLine ? fromTerminal.mode : null;
  const modeId = terminalMode ?? meta.permissionMode;
  const mode = modeId ? modeInfo(modeId) ?? { label: modeId, tone: "normal", hint: "" } : null;

  const cycleMode = () => {
    cycleAt.current = Date.now();
    buffer.current = "";
    clearTimeout(pendingTimer.current);
    // Pas reconnu dans le terminal à temps : on le dit plutôt que d'afficher l'ancien mode.
    pendingTimer.current = setTimeout(() => setPending(true), CYCLE_WINDOW_MS);
    writeToTerminal(sessionId, "\x1b[Z").catch(() => clearTimeout(pendingTimer.current));
  };

  const model = currentModel(meta);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Fermeture au clic à l'extérieur ou sur Échap.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
  const chooseModel = (arg: string) => {
    setMenuOpen(false);
    onCommand(`/model ${arg}`, { quiet: true }).catch(() => {});
  };
  const currentFamily = model ? /^claude-([a-z]+)/i.exec(model.id)?.[1]?.toLowerCase() ?? model.name.split(" ")[0].toLowerCase() : null;
  const currentOneM = model ? /\[1m\]$/i.test(model.id) : false;
  const usage = meta.usage;
  const used = usage ? usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens : null;
  const ctxWindow = model ? contextWindow(model.id) : null;
  const ratio = used != null && ctxWindow ? Math.min(1, used / ctxWindow) : null;

  const contextTitle = usage
    ? [
        t("conversation.footer.contextUsed", { tokens: exact(used!) }),
        t("conversation.footer.contextInput", { tokens: exact(usage.inputTokens) }),
        t("conversation.footer.contextCacheWrite", { tokens: exact(usage.cacheCreationInputTokens) }),
        t("conversation.footer.contextCacheRead", { tokens: exact(usage.cacheReadInputTokens) }),
        ctxWindow ? t("conversation.footer.contextWindow", { tokens: exact(ctxWindow) }) : t("conversation.footer.contextWindowUnknown"),
        t(headSkipped ? "conversation.footer.outputTotalPartial" : "conversation.footer.outputTotal", { tokens: exact(meta.outputTotal) }),
      ].join("\n")
    : t("conversation.footer.noReply");

  if (!model && !mode && !usage) return null;

  return (
    <div className="conv-footer">
      <div className="conv-model-menu" ref={menuRef}>
        <button
          className="conv-footer-item conv-footer-model"
          disabled={!enabled}
          onClick={() => setMenuOpen((o) => !o)}
          title={model ? t("conversation.footer.modelTitle", { id: model.id }) : t("conversation.footer.changeModel")}
        >
          <Cpu size={12} /> {model?.name ?? t("conversation.footer.model")}
        </button>
        {menuOpen && (
          <div className="popover menu conv-model-popover">
            {MODEL_CHOICES.map((c) => {
              const current = c.family != null && c.family === currentFamily && c.oneM === currentOneM;
              return (
                <button key={c.arg} className="menu-item" onClick={() => chooseModel(c.arg)}>
                  <span className="conv-model-check">{current && <Check size={13} />}</span> {c.label()}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <button
        className={`conv-footer-item conv-mode ${pending ? "pending" : mode?.tone ?? "normal"}`}
        disabled={!enabled}
        onClick={cycleMode}
        title={
          pending
            ? [t("conversation.footer.modePendingTitle", { label: mode?.label ?? t("conversation.footer.modeUnknownLower") }), t("conversation.footer.modeCycle")].join("\n")
            : [
                ...(mode
                  ? [mode.hint ? t("conversation.footer.modeTitleWithHint", { label: mode.label, hint: mode.hint }) : t("conversation.footer.modeTitle", { label: mode.label })]
                  : []),
                ...(mode && terminalMode ? [t("conversation.footer.modeFromTerminal")] : []),
                t("conversation.footer.modeCycle"),
              ].join("\n")
        }
      >
        <ShieldCheck size={12} /> {pending ? t("conversation.footer.modePending") : (mode?.label ?? t("conversation.footer.modeUnknown"))}
      </button>
      <span className="conv-footer-spacer" />
      {used != null && (
        <span className="conv-footer-item conv-context" title={contextTitle}>
          {ratio != null && (
            <span className={`conv-context-bar${ratio > 0.8 ? " high" : ""}`}>
              <span style={{ width: `${Math.max(2, ratio * 100)}%` }} />
            </span>
          )}
          {ctxWindow
            ? t("conversation.footer.tokensOfWindow", { used: tokens(used), window: tokens(ctxWindow), percent: Math.round(ratio! * 100) })
            : t("conversation.footer.tokens", { used: tokens(used) })}
        </span>
      )}
    </div>
  );
}
