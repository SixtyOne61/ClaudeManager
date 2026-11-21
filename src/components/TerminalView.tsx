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

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { MessagesSquare, RotateCcw, SquareTerminal, TriangleAlert, X } from "lucide-react";
import { errorMessage } from "../api";
import { newSessionInTerminal, ptyApi, resumeInTerminal, subscribePty } from "../pty";
import { getActivity, isAwaitingPermission, subscribeActivity, type Activity } from "../activity";
import { sendInterrupt, sendMessage, useConversation } from "../conversation";
import { ConversationInput, ConversationView } from "./ConversationView";
import type { SearchFocus } from "./GlobalSearch";

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
}

type RunState = { kind: "starting" } | { kind: "running" } | { kind: "exited"; code: number | null } | { kind: "error"; message: string };

/**
 * Pourquoi le terminal est affiché par-dessus la conversation (null : conversation affichée).
 * `manual` : « Voir le terminal », il ne redescend que sur demande.
 */
type TerminalUp = null | "manual" | "permission" | "question" | "command" | "launch" | "new";

/** Délai sans hook `SessionStart` après le lancement au-delà duquel Claude Code attend
 *  sans doute la question de confiance du dossier. */
const TRUST_DELAY_MS = 1500;
/** Après l'envoi d'une commande `/…`, l'évènement « message envoyé » qui suit est le sien. */
const COMMAND_GRACE_MS = 2000;

/** Explication affichée au-dessus du terminal remonté tout seul. */
function upReason(up: TerminalUp): string | null {
  switch (up) {
    case "permission":
      return "Claude Code demande une permission : réponds dans le terminal.";
    case "question":
      return "Claude Code pose une question : réponds dans le terminal.";
    case "command":
      return "Commande envoyée : termine-la dans le terminal si un menu s'est ouvert.";
    case "launch":
      return "Démarrage de Claude Code : réponds dans le terminal s'il pose une question (confiance du dossier…).";
    case "new":
      return "Nouvelle conversation : réponds dans le terminal s'il pose une question (confiance du dossier…), puis écris ton premier message.";
    default:
      return null;
  }
}

export function TerminalView({ sessionId, cwd, isNew, active, onClose, onStarted, focus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [state, setState] = useState<RunState>({ kind: "starting" });

  // ---- Interface de conversation et terminal qui remonte --------------------------------
  const conversation = useConversation(sessionId, cwd);
  const [up, setUp] = useState<TerminalUp>(isNew ? "new" : null);
  /** Moment où une commande `/…` a été envoyée depuis la zone de saisie. */
  const commandSentAt = useRef(0);
  /** La commande `/…` envoyée a lancé un tour de l'agent (ce n'était pas un menu). */
  const commandTurn = useRef(false);
  /** Nouvelle conversation dont le fichier n'a pas encore de première ligne. */
  const waitingFirstLine = isNew === true && conversation.exists !== true;
  const waitingFirstLineRef = useRef(waitingFirstLine);
  waitingFirstLineRef.current = waitingFirstLine;

  /** Fait redescendre le terminal s'il était remonté tout seul. */
  const lowerAuto = useCallback(() => {
    if (waitingFirstLineRef.current) return;
    setUp((u) => (u === "manual" ? u : null));
  }, []);

  // Première ligne écrite : la nouvelle conversation s'affiche.
  useEffect(() => {
    if (!waitingFirstLine) setUp((u) => (u === "new" ? null : u));
  }, [waitingFirstLine]);

  // Suit l'état de la conversation (hooks de Claude Code, ticket 04).
  useEffect(() => {
    let trustTimer: ReturnType<typeof setTimeout> | undefined;
    const onActivity = (a: Activity | null) => {
      clearTimeout(trustTimer);
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
        // `claude` lancé, aucun hook encore : s'il tarde, il attend sans doute la question de confiance.
        trustTimer = setTimeout(() => setUp((u) => (u === null ? "launch" : u)), TRUST_DELAY_MS);
      } else if (a?.kind === "start") {
        // `SessionStart` reçu : la question de confiance est passée.
        setUp((u) => (u === "launch" ? null : u));
      }
    };
    onActivity(getActivity(sessionId));
    const unsubscribe = subscribeActivity(sessionId, onActivity);
    return () => {
      clearTimeout(trustTimer);
      unsubscribe();
    };
  }, [sessionId, lowerAuto]);

  const send = async (text: string) => {
    const isCommand = text.startsWith("/");
    if (isCommand) {
      commandSentAt.current = Date.now();
      commandTurn.current = false;
    }
    await sendMessage(sessionId, text);
    // Une commande `/…` peut ouvrir un menu interactif : le terminal remonte.
    if (isCommand) setUp((u) => (u === "manual" ? u : "command"));
  };
  const terminalShown = up !== null;
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

    const dataSub = term.onData((d) => ptyApi.write(sessionId, d).catch(() => {}));
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

  return (
    <div className="terminal-view" style={{ display: active ? undefined : "none" }}>
      {state.kind === "exited" && (
        <div className="banner terminal-banner">
          <TriangleAlert size={15} />
          <span>Claude Code s'est terminé{state.code != null ? ` (code ${state.code})` : ""}.</span>
          <button className="btn small primary" onClick={relaunch}>
            <RotateCcw size={13} /> Relancer
          </button>
          <button className="btn small ghost" onClick={onClose}>
            <X size={13} /> Fermer l'onglet
          </button>
        </div>
      )}
      {state.kind === "error" && (
        <div className="banner warn terminal-banner">
          <TriangleAlert size={15} />
          <span className="terminal-error">{state.message}</span>
          <button className="btn small" onClick={relaunch}>
            <RotateCcw size={13} /> Réessayer
          </button>
        </div>
      )}
      <div className="conv-toolbar">
        {terminalShown ? (
          <button className="btn small" onClick={() => setUp(null)} title="Revenir à l'interface de conversation">
            <MessagesSquare size={13} /> Revenir à la conversation
          </button>
        ) : (
          <button className="btn small" onClick={() => setUp("manual")} title="Afficher le vrai terminal de Claude Code">
            <SquareTerminal size={13} /> Voir le terminal
          </button>
        )}
        {upReason(up) && <span className="conv-toolbar-reason">{upReason(up)}</span>}
      </div>
      <div className="conv-stage">
        <div className="terminal-host" ref={hostRef} />
        <ConversationView data={conversation} focus={focus} hidden={terminalShown} />
      </div>
      <ConversationInput
        enabled={state.kind === "running"}
        onSend={send}
        onStop={() => sendInterrupt(sessionId).catch(() => {})}
        autoFocus={active && !terminalShown}
      />
    </div>
  );
}
