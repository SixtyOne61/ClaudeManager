// Pied de la conversation, comme dans Claude Desktop : modèle, mode de permission et contexte
// utilisé, lus dans le `.jsonl` (voir `conversation::Meta`).
//
// - Modèle : clic → `/model` envoyé au terminal, qui remonte (son menu s'y ouvre).
// - Mode : clic → Maj+Tab (ESC [ Z) envoyé au terminal, qui passe au mode suivant. Claude Code
//   n'écrit le mode dans le `.jsonl` qu'avec le message suivant : le nouveau mode est donc lu
//   dans la sortie du terminal (« ⏵⏵ accept edits on (shift+tab to cycle) »). S'il n'y est pas
//   reconnu, le badge l'indique (« visible au prochain message »).
// - Contexte : entrée + cache écrit + cache lu de la dernière réponse, rapportés à la fenêtre
//   de contexte du modèle quand elle est connue.

import { useEffect, useRef, useState } from "react";
import { Cpu, ShieldCheck } from "lucide-react";
import type { ConversationMeta } from "../conversation";
import { watchPtyOutput, writeToTerminal } from "../pty";

interface Props {
  sessionId: string;
  meta: ConversationMeta;
  /** Début de la conversation non lu (gros fichier) : la somme des jetons produits est partielle. */
  headSkipped: boolean;
  /** `claude` tourne dans le terminal : les clics peuvent lui envoyer des touches. */
  enabled: boolean;
  /** Envoie une commande `/…` comme la zone de saisie (le terminal remonte). */
  onCommand: (text: string) => Promise<void>;
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

/** Modèle affiché : l'annonce de Claude Code (nom lisible, `[1m]`) si elle porte sur le même
 *  modèle que la dernière réponse, sinon le modèle de la dernière réponse. */
function currentModel(meta: ConversationMeta): { id: string; name: string } | null {
  const ident = meta.modelIdentity;
  const sameAsLast = ident && (!meta.model || ident.id.replace(/\[1m\]$/i, "") === meta.model);
  if (ident && sameAsLast) return { id: ident.id, name: modelLabel(ident.id) };
  if (meta.model) return { id: meta.model, name: modelLabel(meta.model) };
  return null;
}

// ---- Mode de permission ----------------------------------------------------------------

/** Modes de Claude Code (https://code.claude.com/docs/en/permissions) : libellé et couleur. */
const MODES: Record<string, { label: string; tone: string; hint: string }> = {
  default: { label: "Normal", tone: "normal", hint: "Claude Code demande la permission avant d'agir." },
  acceptEdits: { label: "Accepter les modifications", tone: "edits", hint: "Les modifications de fichiers sont acceptées sans demander." },
  plan: { label: "Plan", tone: "plan", hint: "Claude Code explore et propose un plan, sans rien modifier." },
  auto: { label: "Auto", tone: "auto", hint: "Un classifieur valide les actions sans danger, les autres sont demandées ou refusées." },
  bypassPermissions: { label: "Contourner les permissions", tone: "danger", hint: "Aucune permission n'est demandée : toutes les actions sont exécutées." },
  dontAsk: { label: "Ne pas demander", tone: "dontask", hint: "Les actions non autorisées d'avance sont refusées sans demander." },
};

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
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}${nbsp}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}${nbsp}k`;
  return String(n);
}
const exact = (n: number) => n.toLocaleString("fr-FR");

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
  const mode = modeId ? MODES[modeId] ?? { label: modeId, tone: "normal", hint: "" } : null;

  const cycleMode = () => {
    cycleAt.current = Date.now();
    buffer.current = "";
    clearTimeout(pendingTimer.current);
    // Pas reconnu dans le terminal à temps : on le dit plutôt que d'afficher l'ancien mode.
    pendingTimer.current = setTimeout(() => setPending(true), CYCLE_WINDOW_MS);
    writeToTerminal(sessionId, "\x1b[Z").catch(() => clearTimeout(pendingTimer.current));
  };

  const model = currentModel(meta);
  const usage = meta.usage;
  const used = usage ? usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens : null;
  const ctxWindow = model ? contextWindow(model.id) : null;
  const ratio = used != null && ctxWindow ? Math.min(1, used / ctxWindow) : null;

  const contextTitle = usage
    ? [
        `Contexte utilisé (dernière réponse) : ${exact(used!)} jetons`,
        `  · entrée hors cache : ${exact(usage.inputTokens)}`,
        `  · écrits dans le cache : ${exact(usage.cacheCreationInputTokens)}`,
        `  · lus depuis le cache : ${exact(usage.cacheReadInputTokens)}`,
        ctxWindow ? `Fenêtre de contexte du modèle : ${exact(ctxWindow)} jetons` : "Fenêtre de contexte du modèle inconnue",
        `Jetons produits dans la conversation : ${exact(meta.outputTotal)}${headSkipped ? " (partie affichée seulement)" : ""}`,
      ].join("\n")
    : "Pas encore de réponse de l'agent.";

  if (!model && !mode && !usage) return null;

  return (
    <div className="conv-footer">
      <button
        className="conv-footer-item conv-footer-model"
        disabled={!enabled}
        onClick={() => onCommand("/model").catch(() => {})}
        title={model ? `Modèle : ${model.id}\nCliquer pour en changer (/model, dans le terminal)` : "Changer de modèle (/model)"}
      >
        <Cpu size={12} /> {model?.name ?? "Modèle"}
      </button>
      <button
        className={`conv-footer-item conv-mode ${pending ? "pending" : mode?.tone ?? "normal"}`}
        disabled={!enabled}
        onClick={cycleMode}
        title={
          pending
            ? `Mode précédent : ${mode?.label ?? "inconnu"}. Le nouveau mode n'a pas été reconnu dans le terminal : il s'affichera au prochain message.\nCliquer pour passer au mode suivant (Maj+Tab)`
            : `${mode ? `Mode : ${mode.label}${mode.hint ? ` — ${mode.hint}` : ""}${terminalMode ? "\n(lu dans le terminal)" : ""}\n` : ""}Cliquer pour passer au mode suivant (Maj+Tab)`
        }
      >
        <ShieldCheck size={12} /> {pending ? "Mode changé — visible au prochain message" : (mode?.label ?? "Mode inconnu")}
      </button>
      <span className="conv-footer-spacer" />
      {used != null && (
        <span className="conv-footer-item conv-context" title={contextTitle}>
          {ratio != null && (
            <span className={`conv-context-bar${ratio > 0.8 ? " high" : ""}`}>
              <span style={{ width: `${Math.max(2, ratio * 100)}%` }} />
            </span>
          )}
          {tokens(used)}
          {ctxWindow ? ` / ${tokens(ctxWindow)} (${Math.round(ratio! * 100)}${nbsp}%)` : " jetons"}
        </span>
      )}
    </div>
  );
}
