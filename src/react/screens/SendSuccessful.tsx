import { screenCardStyle } from "./shared";
import { t, type Locale } from "../i18n";

export interface SendSuccessfulProps {
  title?: string;
  message?: string;
  doneLabel?: string;
  onDone?: () => void;
  locale?: Locale;
}

/** A simple full-bleed success state for a completed send. */
export function SendSuccessful({
  locale = "en",
  title = t(locale, "sendSuccessful"),
  message = t(locale, "sendSuccessMessage"),
  doneLabel = t(locale, "done"),
  onDone,
}: SendSuccessfulProps) {
  return (
    <div
      style={{
        ...screenCardStyle,
        fontFamily: "Helvetica, Arial, sans-serif",
        background: "#fff",
        borderRadius: 24,
        padding: 20,
        color: "#111827",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div style={{ width: 96, height: 96, borderRadius: "50%", background: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 20 }}>
        <span style={{ color: "#fff", fontSize: 44, fontWeight: 700 }}>✓</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, marginTop: 24 }}>{title}</div>
      <div style={{ fontSize: 14, color: "#6B7280", textAlign: "center", marginTop: 10, lineHeight: 1.5, maxWidth: 280 }}>{message}</div>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onDone}
        style={{ width: "100%", background: "#111827", color: "#fff", border: "none", borderRadius: 16, padding: 16, fontSize: 16, fontWeight: 700, marginTop: 16, cursor: "pointer" }}
      >
        {doneLabel}
      </button>
    </div>
  );
}
