// Terminal intégré d'une conversation : xterm.js relié au pseudo-terminal du backend.
// Le composant reste monté quand on change d'onglet (il est seulement masqué), pour
// que la conversation continue de tourner et que rien ne soit perdu.
//
// Par-dessus le terminal, l'interface de conversation (ticket 05) affiche le `.jsonl` et
// envoie les messages tapés dans sa zone de saisie. Le terminal reste vivant dessous
// (seulement caché) et remonte tout seul quand Claude Code attend une interaction :
// - permission ou question (état « action requise », ticket 04) ;
// - commande `/…` envoyée depuis la zone de saisie (elle peut ouvrir un menu) ;
// - question de confiance d'un dossier : `claude` lancé mais aucun hook `SessionStart`
//   reçu après un court délai et, pour une nouvelle conversation, tant que son fichier n'a
//   pas de première ligne.
// Il redescend dès que l'agent reprend son travail. L'app ne répond jamais elle-même à une
// demande de permission : c'est l'utilisateur qui valide dans le terminal.
//
// La barre d'outils porte aussi les boutons Hand off (voir src/handoff.ts) et Terminer (voir
// src/skills.ts : ferme l'onglet et lance l'analyse de fin de conversation) et, après un hand
// off, les liens « ← Suite de … » (vers la parente) et « Suite : … → » (vers la suite).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ArrowLeft, ArrowRight, CircleCheck, FolderOpen, Handshake, Loader2, MessagesSquare, RotateCcw, SquareTerminal, TriangleAlert, X } from "lucide-react";
import { api, errorMessage } from "../api";
import { newSessionInTerminal, ptyApi, resumeInTerminal, subscribePty } from "../pty";
import { getActivity, isAwaitingPermission, subscribeActivity, type Activity } from "../activity";
import { editableMessage, messageKey, sendEditedMessage, sendInterrupt, sendMessage, useConversation, type EditableMessage } from "../conversation";
import { ConversationInput, ConversationView } from "./ConversationView";
import { ConversationFooter } from "./ConversationFooter";
import { GrillBackBar, GrillForm, useGrillMode } from "./Grill";
import { pendingRound } from "../grill";
import type { SearchFocus } from "./GlobalSearch";
import { SuggestionBanners, type SuggestionActionHandler } from "./Suggestions";
import { ACTION_HAND_OFF, dismissStale, forgetStale, type Suggestion } from "../suggestions";
import { cancelHandoff, useHandoffBlocker, useHandoffState, type HandoffLineage } from "../handoff";
import { parseConfirmPrompt, samePrompt, type ConfirmPrompt } from "../terminalPrompt";
import { ConfirmCard } from "./ConfirmCard";
import { t } from "../i18n";
import { tSplit } from "../i18n/rich";


interface Props {
  sessionId: string;
  cwd: string;
  /** Nouvelle conversation : `claude --session-id` au lieu de `--resume`. */
  isNew?: boolean;
  active: boolean;
  onClose: () => void;
  /** Appelé après chaque lancement réussi de `claude`. */
  onStarted?: () => void;
  /** Résultat de la recherche globale à montrer dans la conversation. */
  focus?: SearchFocus | null;
  /** « Ignorer » sur une suggestion de cette conversation. */
  onDismissSuggestion?: (s: Suggestion) => void;
  /** Gestionnaires des actions des suggestions (voir SuggestionBanners). */
  suggestionActions?: Partial<Record<string, SuggestionActionHandler>>;
  /** Hand off de cette conversation (barre d'outils, bandeau « Contexte rempli »). */
  onHandoff?: () => void;
  /** Terminer : ferme l'onglet et lance l'analyse de fin de conversation (`analyse` : réglage actif). */
  onFinish?: { run: () => void; analyse: boolean };
  /** Parente et suite de cette conversation : liens « ← Suite de … » et « Suite : … → ». */
  lineage?: HandoffLineage;
  /** Ouvre une conversation par son identifiant (onglet, ou archives). */
  onOpenConversation?: (sessionId: string) => void;
  /** L'utilisateur tape dans le terminal ou la zone de saisie (règle « conversation ancienne »). */
  onTyping?: () => void;
}

type RunState = { kind: "starting" } | { kind: "running" } | { kind: "exited"; code: number | null } | { kind: "error"; message: string };

/**
 * Pourquoi le terminal est affiché par-dessus la conversation (null : conversation affichée).
 * `manual` : « Voir le terminal », il ne redescend que sur demande.
 */
type TerminalUp = null | "manual" | "permission" | "question" | "command" | "launch";

/** Question de confiance du dossier posée par Claude Code au démarrage (selon les versions :
 *  « Do you trust the files in this folder? », « …one you trust? », « Yes, I trust this folder »). */
const TRUST_PROMPT = /trust (the files in )?this folder|one you trust/i;
/** Entre le lancement et le hook `SessionStart`, l'écran du terminal est relu à cet intervalle… */
const TRUST_POLL_MS = 400;
/** …pendant au plus ce délai (sans hooks, `SessionStart` n'arrive jamais). */
const TRUST_WATCH_MS = 60_000;
/** Après l'envoi d'une commande `/…`, l'évènement « message envoyé » qui suit est le sien. */
const COMMAND_GRACE_MS = 2000;
/** Après une commande « silencieuse », l'écran est relu à cet intervalle… */
const CONFIRM_POLL_MS = 150;
/** …pendant ce délai pour voir la confirmation apparaître (elle s'affiche en moins d'une seconde). */
const CONFIRM_APPEAR_MS = 3000;

/** Explication affichée au-dessus du terminal remonté tout seul. */
function upReason(up: TerminalUp): string | null {
  switch (up) {
    case "permission":
      return t("conversation.terminal.upPermission");
    case "question":
      return t("conversation.terminal.upQuestion");
    case "command":
      return t("conversation.terminal.upCommand");
    case "launch":
      return t("conversation.terminal.upLaunch");
    default:
      return null;
  }
}

/** L'agent travaille encore sur le dernier message : en cours, ou permission / question en attente. */
function isBusy(a: Activity | null): boolean {
  return a?.state === "running" || isAwaitingPermission(a);
}

export function TerminalView({
  sessionId,
  cwd,
  isNew,
  active,
  onClose,
  onStarted,
  focus,
  onDismissSuggestion,
  suggestionActions,
  onHandoff,
  onFinish,
  lineage,
  onOpenConversation,
  onTyping,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Lu par le terminal (abonnement créé une fois) : toujours la version à jour.
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;
  // Conversation fermée : la règle « conversation ancienne » repartira de zéro à la réouverture.
  useEffect(() => () => forgetStale(sessionId), [sessionId]);

  // ---- Hand off (voir src/handoff.ts) ----------------------------------------------------
  /** Raison pour laquelle Hand off est grisé (null : disponible). */
  const handoffReason = useHandoffBlocker(sessionId);
  const handoffPhase = useHandoffState(sessionId);
  /** Actions des bandeaux de suggestion, avec Hand off pour cette conversation. */
  const bannerActions = useMemo(
    () =>
      onHandoff
        ? {
            ...suggestionActions,
            [ACTION_HAND_OFF]: {
              run: () => {
                dismissStale(sessionId);
                onHandoff();
              },
              disabledReason: handoffReason,
            },
          }
        : suggestionActions,
    [suggestionActions, onHandoff, handoffReason, sessionId],
  );
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [state, setState] = useState<RunState>({ kind: "starting" });

  // ---- Interface de conversation et terminal qui remonte --------------------------------
  const conversation = useConversation(sessionId, cwd);
  /** Série de questions de Claude encore sans réponse : formulaire à la place de la zone de saisie. */
  const grill = useMemo(() => pendingRound(conversation.entries), [conversation.entries]);
  const grillMode = useGrillMode(sessionId, grill);
  const [up, setUp] = useState<TerminalUp>(null);
  /** Moment où une commande `/…` a été envoyée depuis la zone de saisie. */
  const commandSentAt = useRef(0);
  /** La commande `/…` envoyée a lancé un tour de l'agent (ce n'était pas un menu). */
  const commandTurn = useRef(false);

  // ---- Modification du dernier message (tant que Claude n'a pas commencé à répondre) ----
  /** L'agent travaille sur le dernier message (ou attend une permission pendant ce tour). */
  const [agentBusy, setAgentBusy] = useState(() => isBusy(getActivity(sessionId)));
  /** Message en cours de modification : l'agent a été interrompu, la zone de saisie le contient. */
  const [editing, setEditing] = useState<EditableMessage | null>(null);
  /** Messages remplacés par leur version modifiée (pendant que l'app est ouverte). */
  const [replaced, setReplaced] = useState<ReadonlySet<string>>(() => new Set());
  const editable = useMemo(() => (agentBusy && !editing ? editableMessage(conversation.entries) : null), [agentBusy, editing, conversation.entries]);

  /** Fait redescendre le terminal s'il était remonté tout seul. */
  const lowerAuto = useCallback(() => {
    setUp((u) => (u === "manual" ? u : null));
  }, []);

  /** Lignes visibles de l'écran du terminal. */
  const screenLines = useCallback(() => {
    const term = termRef.current;
    if (!term) return [];
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    return lines;
  }, []);
  /** L'écran du terminal affiche la question de confiance du dossier. */
  const trustPromptShown = useCallback(() => TRUST_PROMPT.test(screenLines().join(" ").replace(/\s+/g, " ")), [screenLines]);

  /**
   * Boîte de confirmation ouverte par une commande « silencieuse » (« Switch model? » après
   * `/model` en cours de conversation). Cachée sous la conversation, elle avalerait le message
   * suivant (texte collé ignoré, Entrée qui valide la boîte) : elle est donc reprise dans la
   * conversation (ConfirmCard), à la place de la zone de saisie, tant qu'elle est à l'écran.
   */
  const [confirm, setConfirm] = useState<ConfirmPrompt | null>(null);
  const confirmWatch = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => () => clearInterval(confirmWatch.current), []);
  const watchConfirm = useCallback(() => {
    clearInterval(confirmWatch.current);
    const until = Date.now() + CONFIRM_APPEAR_MS;
    let shown = false;
    confirmWatch.current = setInterval(() => {
      const prompt = parseConfirmPrompt(screenLines());
      if (prompt) {
        shown = true;
        setConfirm((c) => (samePrompt(c, prompt) ? c : prompt));
      } else if (shown || Date.now() > until) {
        clearInterval(confirmWatch.current);
        setConfirm(null);
      }
    }, CONFIRM_POLL_MS);
  }, [screenLines]);
  /** Réponse à la boîte depuis la carte : touches envoyées au terminal, comme au clavier. */
  const answerConfirm = (keys: string) => {
    ptyApi.write(sessionId, keys).catch(() => {});
  };

  // Suit l'état de la conversation (hooks de Claude Code, ticket 04).
  useEffect(() => {
    let trustWatch: ReturnType<typeof setInterval> | undefined;
    const onActivity = (a: Activity | null) => {
      clearInterval(trustWatch);
      setAgentBusy(isBusy(a));
      if (a && isAwaitingPermission(a)) {
        const reason = a.kind === "question" ? "question" : "permission";
        setUp((u) => (u === "manual" ? u : reason));
      } else if (a?.state === "running") {
        // Le message de la commande `/…` elle-même ne compte pas (son menu est peut-être ouvert).
        const ownCommand = a.kind === "prompt" && Date.now() - commandSentAt.current < COMMAND_GRACE_MS;
        if (ownCommand) commandTurn.current = true;
        else lowerAuto();
      } else if (a?.state === "waiting" && a.kind === "turn" && commandTurn.current) {
        // Fin du tour lancé par une commande `/…` : sa réponse s'affiche dans la conversation.
        commandTurn.current = false;
        setUp((u) => (u === "command" ? null : u));
      } else if (a?.kind === "start" && a.event === "Launch") {
        // `claude` lancé, aucun hook encore : on guette la question de confiance du dossier à
        // l'écran (le terminal ne remonte que si elle s'affiche vraiment).
        const until = Date.now() + TRUST_WATCH_MS;
        trustWatch = setInterval(() => {
          if (trustPromptShown()) {
            clearInterval(trustWatch);
            setUp((u) => (u === null ? "launch" : u));
          } else if (Date.now() > until) clearInterval(trustWatch);
        }, TRUST_POLL_MS);
      } else if (a?.kind === "start") {
        // `SessionStart` reçu : la question de confiance est passée.
        setUp((u) => (u === "launch" ? null : u));
      }
    };
    onActivity(getActivity(sessionId));
    const unsubscribe = subscribeActivity(sessionId, onActivity);
    return () => {
      clearInterval(trustWatch);
      unsubscribe();
    };
  }, [sessionId, lowerAuto, trustPromptShown]);

  /**
   * « Arrêter » : interrompt l'agent. Pendant la rédaction d'un résumé de hand off, c'est aussi
   * l'annulation du hand off (une interruption ne déclenche aucun hook de fin de tour : sans
   * cela, le hand off attendrait indéfiniment). `cancelHandoff` interrompt lui-même l'agent.
   */
  const stop = () => {
    if (handoffPhase === "summary") cancelHandoff(sessionId);
    else sendInterrupt(sessionId).catch(() => {});
  };

  /** ✏️ sur le dernier message : interrompt l'agent et met le message dans la zone de saisie. */
  const startEdit = (m: EditableMessage) => {
    sendInterrupt(sessionId).catch(() => {});
    lowerAuto(); // une permission en attente est annulée par l'interruption
    setEditing(m);
  };

  /** `quiet` : commande dont on connaît l'effet (ex. `/model opus`), qui n'ouvre aucun menu. */
  const send = async (text: string, opts?: { quiet?: boolean }) => {
    if (editing) {
      await sendEditedMessage(sessionId, text, editing.text);
      setReplaced((r) => new Set(r).add(messageKey(editing)));
      setEditing(null);
      return;
    }
    const isCommand = text.startsWith("/");
    if (isCommand) {
      commandSentAt.current = Date.now();
      commandTurn.current = false;
    }
    await sendMessage(sessionId, text);
    // Une commande `/…` peut ouvrir un menu interactif : le terminal remonte.
    if (isCommand && !opts?.quiet) setUp((u) => (u === "manual" ? u : "command"));
    else if (isCommand) watchConfirm();
  };
  const terminalShown = up !== null;
  /** Série de questions affichée en formulaire plein espace (la conversation et le terminal sont repliés). */
  const formVisible = grillMode.showForm && !terminalShown && !confirm;
  /** Confirmation de Claude Code affichée en carte (le terminal remonté la montre déjà). */
  const confirmVisible = !!confirm && !terminalShown;
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  /** Lance `claude --resume` ou `--session-id` (au montage, et via « Relancer »). */
  const start = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    setState({ kind: "starting" });
    try {
      await (isNew ? newSessionInTerminal : resumeInTerminal)(sessionId, cwd, term.cols, term.rows);
      setState({ kind: "running" });
      onStartedRef.current?.();
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  }, [sessionId, cwd, isNew]);

  // Création du terminal xterm, une seule fois par conversation ouverte.
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      scrollback: 10000,
      allowProposedApi: false,
      theme: { background: "#0f1115", foreground: "#e6e8ee", cursor: "#d97757", selectionBackground: "#3a4256" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      /* conteneur encore masqué */
    }

    // Copier-coller : Ctrl+C copie s'il y a une sélection (sinon interrompt, comme d'habitude),
    // Ctrl+V et Ctrl+Maj+V collent (le navigateur déclenche le collage, xterm l'envoie).
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || !ev.ctrlKey) return true;
      const k = ev.key.toLowerCase();
      if (k === "c" && (ev.shiftKey || term.hasSelection())) {
        if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        ev.preventDefault();
        return false;
      }
      if (k === "v") return false;
      return true;
    });

    const dataSub = term.onData((d) => {
      // Les séquences d'échappement (flèches, réponses du terminal, focus) ne sont pas une frappe de message.
      if (!d.startsWith("\x1b")) onTypingRef.current?.();
      ptyApi.write(sessionId, d).catch(() => {});
    });
    const resizeSub = term.onResize(({ cols, rows }) => ptyApi.resize(sessionId, cols, rows).catch(() => {}));

    let unsubscribe: (() => void) | null = null;
    let disposed = false;
    subscribePty(sessionId, {
      onData: (d) => term.write(d),
      onExit: (code) => setState({ kind: "exited", code }),
    }).then((u) => {
      if (disposed) u();
      else {
        unsubscribe = u;
        start();
      }
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Ajuste la taille au conteneur (fenêtre redimensionnée, onglet réaffiché).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const refit = () => {
      if (!host.offsetParent) return; // masqué
      try {
        fitRef.current?.fit();
      } catch {
        /* ignoré */
      }
    };
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    if (active) refit();
    return () => ro.disconnect();
  }, [active]);

  // Le terminal affiché reçoit le clavier (sinon c'est la zone de saisie).
  useEffect(() => {
    if (active && terminalShown) termRef.current?.focus();
  }, [active, terminalShown]);

  const relaunch = () => {
    termRef.current?.reset();
    start();
  };

  const parentText = tSplit("conversation.toolbar.parent", "title");
  const successorText = tSplit("conversation.toolbar.successor", "title");

  return (
    <div className="terminal-view" style={{ display: active ? undefined : "none" }}>
      {state.kind === "exited" && (
        <div className="banner terminal-banner">
          <TriangleAlert size={15} />
          <span>{state.code != null ? t("conversation.terminal.exitedWithCode", { code: String(state.code) }) : t("conversation.terminal.exited")}</span>
          <button className="btn small primary" onClick={relaunch}>
            <RotateCcw size={13} /> {t("conversation.terminal.relaunch")}
          </button>
          <button className="btn small ghost" onClick={onClose}>
            <X size={13} /> {t("conversation.terminal.closeTab")}
          </button>
        </div>
      )}
      {state.kind === "error" && (
        <div className="banner warn terminal-banner">
          <TriangleAlert size={15} />
          <span className="terminal-error">{state.message}</span>
          <button className="btn small" onClick={relaunch}>
            <RotateCcw size={13} /> {t("conversation.terminal.retry")}
          </button>
        </div>
      )}
      <div className="conv-toolbar">
        {terminalShown ? (
          <button className="btn small" onClick={() => setUp(null)} title={t("conversation.toolbar.backToConversationTitle")}>
            <MessagesSquare size={13} /> {t("conversation.toolbar.backToConversation")}
          </button>
        ) : (
          <button className="btn small" onClick={() => setUp("manual")} title={t("conversation.toolbar.showTerminalTitle")}>
            <SquareTerminal size={13} /> {t("conversation.toolbar.showTerminal")}
          </button>
        )}
        <button
          className="btn small"
          onClick={() => api.openFolder(cwd).catch(() => {})}
          title={t("conversation.toolbar.openFolderTitle", { path: cwd })}
        >
          <FolderOpen size={13} /> {t("conversation.toolbar.openFolder")}
        </button>
        {onHandoff && (
          <button
            className="btn small"
            disabled={!!handoffReason}
            onClick={onHandoff}
            title={handoffReason ?? t("conversation.toolbar.handoffTitle")}
          >
            <Handshake size={13} /> {t("conversation.toolbar.handoff")}
          </button>
        )}
        {onFinish && (
          <button
            className="btn small"
            // Même règle que Hand off : la question ne doit pas tomber au milieu d'un tour.
            disabled={!!handoffReason}
            onClick={onFinish.run}
            title={handoffReason ?? t(onFinish.analyse ? "skills.finishTitle" : "skills.finishTitleOff")}
          >
            <CircleCheck size={13} /> {t("skills.finish")}
          </button>
        )}
        {upReason(up) && <span className="conv-toolbar-reason">{upReason(up)}</span>}
        {(lineage?.parent || lineage?.successor) && (
          <span className="conv-lineage">
            {lineage.parent && (
              <button className="link-btn" onClick={() => onOpenConversation?.(lineage.parent!.id)} title={t("conversation.toolbar.parentTitle")}>
                <ArrowLeft size={12} /> {parentText[0]}<em>{lineage.parent.title}</em>{parentText[1]}
              </button>
            )}
            {lineage.successor && (
              <button className="link-btn" onClick={() => onOpenConversation?.(lineage.successor!.id)} title={t("conversation.toolbar.successorTitle")}>
                {successorText[0]}<em>{lineage.successor.title}</em>{successorText[1]} <ArrowRight size={12} />
              </button>
            )}
          </span>
        )}
      </div>
      {handoffPhase && (
        <div className="banner handoff-banner" role="status">
          <Loader2 size={14} className="spin" />
          <span className="handoff-banner-text">
            {handoffPhase === "summary"
              ? t("conversation.handoff.summary")
              : t("conversation.handoff.creating")}
          </span>
          {handoffPhase === "summary" && (
            <button className="btn small ghost" onClick={() => cancelHandoff(sessionId)} title={t("conversation.handoff.cancelTitle")}>
              <X size={12} /> {t("common.cancel")}
            </button>
          )}
        </div>
      )}
      {onDismissSuggestion && <SuggestionBanners sessionId={sessionId} onDismiss={onDismissSuggestion} actions={bannerActions} />}
      <div className={"conv-stage" + (formVisible ? " collapsed" : "")}>
        <div className="terminal-host" ref={hostRef} />
        <ConversationView
          data={conversation}
          focus={focus}
          hidden={terminalShown}
          cwd={cwd}
          sessionId={sessionId}
          editable={state.kind === "running" ? editable : null}
          onEdit={startEdit}
          replaced={replaced}
        />
      </div>
      {grill && formVisible && (
        <GrillForm
          sessionId={sessionId}
          pending={grill}
          enabled={state.kind === "running"}
          onSend={send}
          onStop={stop}
          onFreeText={() => grillMode.setFreeText(true)}
          autoFocus={active && !terminalShown}
        />
      )}
      {grill && grillMode.freeTextOnRound && <GrillBackBar count={grill.round.questions.length} onBack={() => grillMode.setFreeText(false)} />}
      {confirm && confirmVisible && (
        <ConfirmCard prompt={confirm} onAnswer={answerConfirm} autoFocus={active} />
      )}
      {/* Gardée montée sous le formulaire : son brouillon reste. */}
      <div className="conv-input-slot" hidden={formVisible || confirmVisible}>
      <ConversationInput
        enabled={state.kind === "running"}
        onSend={send}
        onStop={stop}
        autoFocus={active && !terminalShown && !formVisible}
        cwd={cwd}
        sessionId={sessionId}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onTyping={onTyping}
      />
      </div>
      <ConversationFooter
        sessionId={sessionId}
        meta={conversation.meta}
        headSkipped={conversation.headSkipped}
        enabled={state.kind === "running"}
        onCommand={send}
      />
    </div>
  );
}
