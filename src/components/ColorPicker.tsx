// Sélecteur de couleur : couleurs prédéfinies, « aucune », ou couleur libre.

import { useEffect, useRef, useState } from "react";
import { Palette, X } from "lucide-react";
import { PRESET_COLORS } from "../util";
import { t } from "../i18n";

interface Props {
  value: string | null | undefined;
  onChange: (color: string | null) => void;
  title?: string;
  /** Bouton déclencheur réduit à une icône (dans les en-têtes de la barre latérale). */
  compact?: boolean;
}

export function ColorPicker({ value, onChange, title = t("common.color"), compact }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fermeture au clic à l'extérieur ou sur Échap.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="color-picker" ref={ref} onPointerDown={(e) => e.stopPropagation()}>
      <button
        className={compact ? "icon-btn" : "btn"}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {compact ? (
          <Palette size={14} />
        ) : (
          <>
            <span className="swatch-dot" style={{ background: value ?? "transparent" }} />
            {title}
          </>
        )}
      </button>
      {open && (
        <div className="popover" onClick={(e) => e.stopPropagation()}>
          <div className="swatches">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                className={"swatch" + (value === c ? " selected" : "")}
                style={{ background: c }}
                title={c}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <div className="popover-row">
            <label className="custom-color" title={t("app.color.custom")}>
              <input type="color" value={value ?? "#7c3aed"} onChange={(e) => onChange(e.target.value)} />
              {t("app.color.custom")}
            </label>
            <button
              className="btn ghost small"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              <X size={12} /> {t("app.color.none")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
