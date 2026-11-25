// Bouton ▶ d'un bloc de commande (`bash`, `powershell`, `cmd`…) d'une réponse de l'agent,
// et terminal intégré qui se déplie sous le bloc pour l'exécuter (voir `runner.ts`).
//
// - ▶ (clic) : exécute dans le terminal intégré, dans le dossier de la conversation ;
// - clic droit sur ▶, ou bouton « fenêtre » : exécute dans un nouveau terminal externe.
// Rien ne s'exécute sans un clic de l'utilisateur.

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Check, Copy, Play, RotateCcw, Square, SquareArrowOutUpRight, X } from "lucide-react";
import { errorMessage } from "../api";
import { t } from "../i18n";
import { attachRun, closeRun, launchRun, prepareRun, resizeRun, runExternal, shellLabel, stopRun, useRun, writeRun, type Run } from "../runner";

export interface RunnableBlock {
  /** Identifiant stable du bloc (message + rang du bloc dans le message). */
  id: string;
  lang: string;
  code: string;
  /** Élément placé sous le `<pre>` du bloc, où le composant est dessiné. */
  host: HTMLElement;
}

export function CodeRunnerPortal({ block, cwd }: { block: RunnableBlock; cwd: string | null }) {
  return createPortal(<CodeRunner block={block} cwd={cwd} />, block.host);
}

function CodeRunner({ block, cwd }: { block: RunnableBlock; cwd: string | null }) {
  const run = useRun(block.id);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const shell = shellLabel(block.lang);
  const disabled = !cwd;

  const runInline = () => {
    if (!cwd) return;
    setError(null);
    prepareRun(block.id, block.lang, block.code, cwd);
  };
  const runOutside = (e?: MouseEvent) => {
    e?.preventDefault();
    if (!cwd) return;
    setError(null);
    runExternal(block.lang, block.code, cwd).catch((err) => setError(errorMessage(err)));
  };
  const copy = () => {
    navigator.clipboard
      ?.writeText(block.code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  const running = run?.state.kind === "running" || run?.state.kind === "pending";
  const where = disabled ? t("tools.runner.cwdUnknown") : t("tools.runner.inCwd", { cwd });

  return (
    <>
      <div className="code-tools">
        <button className="icon-btn bare" title={t("tools.runner.copy")} onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button className="icon-btn bare" title={t("tools.runner.runExternalTitle", { shell, where })} onClick={() => runOutside()} disabled={disabled}>
          <SquareArrowOutUpRight size={13} />
        </button>
        <button
          className="code-run"
          title={t("tools.runner.runHereTitle", { shell, where })}
          onClick={runInline}
          onContextMenu={runOutside}
          disabled={disabled || running}
        >
          <Play size={11} fill="currentColor" /> {shell}
        </button>
      </div>
      {error && <div className="code-run-error">{error}</div>}
      {run && <RunPanel key={run.runId} blockId={block.id} run={run} onRerun={runInline} />}
    </>
  );
}

function RunPanel({ blockId, run, onRerun }: { blockId: string; run: Run; onRerun: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 12.5,
      scrollback: 5000,
      convertEol: false,
      theme: { background: "#0b0d11", foreground: "#e6e8ee", cursor: "#d97757", selectionBackground: "#3a4256" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    try {
      fit.fit();
    } catch {
      /* conteneur encore masqué */
    }

    // Ctrl+C copie s'il y a une sélection (sinon interrompt la commande), Ctrl+V colle.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || !ev.ctrlKey) return true;
      const k = ev.key.toLowerCase();
      if (k === "c" && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      return k !== "v";
    });

    // Sortie rejouée (panneau recréé) : les réponses automatiques de xterm aux questions
    // du terminal déjà traitées ne doivent pas repartir vers la commande.
    let replaying = false;
    const dataSub = term.onData((d) => !replaying && writeRun(blockId, d));
    const resizeSub = term.onResize(({ cols, rows }) => resizeRun(blockId, cols, rows));
    const detach = attachRun(
      blockId,
      (past) => {
        replaying = true;
        term.write(past, () => (replaying = false));
      },
      (d) => term.write(d),
    );
    launchRun(blockId, term.cols, term.rows);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* masqué */
      }
    });
    ro.observe(hostRef.current!);
    return () => {
      ro.disconnect();
      detach();
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
    };
  }, [blockId]);

  const s = run.state;
  return (
    <div className="run-panel">
      <div className="run-panel-head">
        <span className={"run-status " + s.kind + (s.kind === "exited" && s.code !== 0 ? " failed" : "")}>
          {s.kind === "pending" && t("tools.runner.statusStarting")}
          {s.kind === "running" && t("tools.runner.statusRunning")}
          {s.kind === "exited" && (s.code == null ? t("tools.runner.statusStopped") : s.code === 0 ? t("tools.runner.statusDone") : t("tools.runner.statusDoneCode", { code: String(s.code) }))}
          {s.kind === "error" && s.message}
        </span>
        <span className="run-panel-cwd" title={run.cwd}>
          {run.cwd}
        </span>
        {s.kind === "running" ? (
          <button className="icon-btn bare" title={t("tools.runner.stop")} onClick={() => stopRun(blockId)}>
            <Square size={12} />
          </button>
        ) : (
          <button className="icon-btn bare" title={t("tools.runner.rerun")} onClick={onRerun}>
            <RotateCcw size={12} />
          </button>
        )}
        <button className="icon-btn bare" title={t("common.close")} onClick={() => closeRun(blockId)}>
          <X size={12} />
        </button>
      </div>
      <div className="run-panel-term" ref={hostRef} />
    </div>
  );
}
