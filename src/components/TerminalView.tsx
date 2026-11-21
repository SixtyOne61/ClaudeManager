// Terminal intégré d'une conversation : xterm.js relié au pseudo-terminal du backend.
// Le composant reste monté quand on change d'onglet (il est seulement masqué), pour
// que la conversation continue de tourner et que rien ne soit perdu.

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { RotateCcw, TriangleAlert, X } from "lucide-react";
import { errorMessage } from "../api";
import { ptyApi, resumeInTerminal, subscribePty } from "../pty";

interface Props {
  sessionId: string;
  cwd: string;
  active: boolean;
  onClose: () => void;
}

type RunState = { kind: "starting" } | { kind: "running" } | { kind: "exited"; code: number | null } | { kind: "error"; message: string };

export function TerminalView({ sessionId, cwd, active, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [state, setState] = useState<RunState>({ kind: "starting" });

  /** Lance `claude --resume` (au montage, et via « Relancer »). */
  const start = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    setState({ kind: "starting" });
    try {
      await resumeInTerminal(sessionId, cwd, term.cols, term.rows);
      setState({ kind: "running" });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  }, [sessionId, cwd]);

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
    if (active) {
      refit();
      termRef.current?.focus();
    }
    return () => ro.disconnect();
  }, [active]);

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
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
