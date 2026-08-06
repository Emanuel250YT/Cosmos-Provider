export interface DetailRowProps {
  label: string;
  value: string;
  valueColor?: string;
  /** When set, `value` renders as a link to this URL (e.g. a block explorer tx page) instead of plain text — opens in a new tab. */
  href?: string;
  /**
   * Marks `value` as a long, copy-oriented id (a tx hash, not prose) — it
   * renders truncated (`abcd12…34ef56`) with the full string in a `title`
   * tooltip, plus a small copy button next to it.
   *
   * The copy button doesn't call `navigator.clipboard` itself — server-only
   * rendering (`renderToStaticMarkup`, no hydration) can't attach a React
   * `onClick` handler that will actually run. Instead it's a plain
   * `<button data-copy-value="...">`; wire up ONE delegated listener
   * wherever this tree is mounted/rendered, e.g.:
   * `document.addEventListener('click', (e) => { const btn =
   * e.target.closest('[data-copy-value]'); if (btn)
   * navigator.clipboard.writeText(btn.dataset.copyValue); })`. Works
   * identically whether the page hydrates or not.
   */
  copyable?: boolean;
  /**
   * Renders `value` with each word's first letter capitalized (e.g. a raw
   * status like "settling" → "Settling") — for words, not for opaque ids:
   * leave this off for anything like `order.id`, a charge id, or a tx hash,
   * where capitalization would just be noise (or actively wrong — hex
   * strings and UUIDs aren't case-normalized). Purely a display transform
   * (CSS `text-transform`); `value` itself, and whatever `copyable` copies,
   * are unaffected.
   */
  capitalize?: boolean;
}

/** `abcd1234…ef567890` — first/last 6 chars, only when that's actually shorter than the original. */
function truncateMiddle(value: string): string {
  return value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

/** A label/value line for a transaction detail sheet (status, date, id...). `value` renders as a link when `href` is set, truncated with a copy button when `copyable` is set, capitalized when `capitalize` is set — always right-aligned against `label`. */
export function DetailRow({ label, value, valueColor = "var(--cosmos-fg, #111827)", href, copyable = false, capitalize = false }: DetailRowProps) {
  const displayValue = copyable ? truncateMiddle(value) : value;
  const valueStyle = { fontSize: 14, fontWeight: 600, color: valueColor, textTransform: capitalize ? ("capitalize" as const) : undefined };

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 0",
        fontFamily: "Helvetica, Arial, sans-serif",
        gap: 12,
      }}
    >
      <span style={{ fontSize: 14, color: "var(--cosmos-muted, #9CA3AF)" }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, textAlign: "right" }}>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" title={copyable ? value : undefined} style={{ ...valueStyle, textDecoration: "underline", textUnderlineOffset: 2 }}>
            {displayValue}
          </a>
        ) : (
          <span title={copyable ? value : undefined} style={valueStyle}>
            {displayValue}
          </span>
        )}
        {copyable ? (
          <button
            type="button"
            data-copy-value={value}
            aria-label="Copy"
            title="Copy"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              padding: 0,
              flexShrink: 0,
              border: "none",
              background: "none",
              color: "var(--cosmos-muted, #9CA3AF)",
              cursor: "pointer",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        ) : null}
      </span>
    </div>
  );
}
