import { DetailRow, type DetailRowProps } from "../primitives/DetailRow";
import { screenCardStyle } from "./shared";
import { t, type Locale } from "../i18n";

export interface PaymentConfirmationProps {
  itemTitle: string;
  itemSubtitle: string;
  /** Rows rendered as `DetailRow`s, in order — e.g. amount, status, bill id, then payment method, date, time, then tax and total. */
  rows: Array<DetailRowProps>;
  /** Provider/item logo shown in the header circle — a striped placeholder when omitted. */
  logoUrl?: string;
  /**
   * Text the Share button hands off — defaults to `${itemTitle} — ${itemSubtitle}`.
   * Also set as `data-share-text` on the button itself (see `onShare`'s docstring)
   * so a page with no React hydration can still wire up a real share action.
   */
  shareText?: string;
  /**
   * Called on click, for a hydrated React app that wants to run its own share
   * logic (e.g. `navigator.share(...)`). For a page rendered with
   * `renderToStaticMarkup` and no hydration (`onClick` never attaches, there's
   * no JS runtime backing this tree), the button ALSO carries
   * `data-cosmos-action="share"` and `data-share-text="..."` — wire up a
   * delegated listener wherever this is mounted, e.g.:
   * `document.addEventListener('click', (e) => { const btn =
   * e.target.closest('[data-cosmos-action="share"]'); if (btn &&
   * navigator.share) navigator.share({ text: btn.dataset.shareText }); })`.
   */
  onShare?: () => void;
  /** Same idea as `onShare`, but for a "Print" button carrying `data-cosmos-action="print"` — a delegated listener can just call `window.print()`. */
  onPrint?: () => void;
  locale?: Locale;
}

/** "Payment success" summary card with Print and Share actions. */
export function PaymentConfirmation({ itemTitle, itemSubtitle, rows, logoUrl, shareText, onShare, onPrint, locale = "en" }: PaymentConfirmationProps) {
  const resolvedShareText = shareText ?? `${itemTitle} — ${itemSubtitle}`;
  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "var(--cosmos-bg-soft, #F7F7F8)", borderRadius: 24, paddingBottom: 24, color: "var(--cosmos-fg, #111827)" }}>
      <div style={{ padding: "16px 20px" }}>
        <div style={{ fontSize: 28, fontWeight: 800, marginTop: 8 }}>{t(locale, "paymentSuccess")}</div>
        <div style={{ fontSize: 14, color: "var(--cosmos-muted, #6B7280)", marginTop: 6 }}>{t(locale, "paymentDoneMessage")}</div>

        <div style={{ background: "var(--cosmos-panel, #fff)", borderRadius: 16, padding: 16, marginTop: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingBottom: 14,
              borderBottom: "1px solid var(--cosmos-border, #F0F0F1)",
              marginBottom: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  flexShrink: 0,
                  boxSizing: "border-box",
                  overflow: "hidden",
                  background: logoUrl
                    ? "#fff"
                    : "repeating-linear-gradient(45deg, var(--cosmos-border, #E5E7EB), var(--cosmos-border, #E5E7EB) 4px, var(--cosmos-bg-soft, #EDEEF0) 4px, var(--cosmos-bg-soft, #EDEEF0) 8px)",
                  border: logoUrl ? "1px solid var(--cosmos-border, #F0F0F1)" : undefined,
                  padding: logoUrl ? 5 : undefined,
                  display: logoUrl ? "flex" : undefined,
                  alignItems: logoUrl ? "center" : undefined,
                  justifyContent: logoUrl ? "center" : undefined,
                }}
              >
                {logoUrl ? <img src={logoUrl} alt={itemTitle} style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : null}
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 15, fontWeight: 700 }}>{itemTitle}</span>
                <span style={{ fontSize: 12, color: "var(--cosmos-muted, #9CA3AF)" }}>{itemSubtitle}</span>
              </div>
            </div>
            <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>✓</span>
            </div>
          </div>
          {rows.map((row, i) => (
            <DetailRow key={i} {...row} />
          ))}
        </div>
      </div>

      <div className="cosmos-no-print" style={{ padding: "0 20px", display: "flex", gap: 10 }}>
        <button
          type="button"
          onClick={onPrint}
          data-cosmos-action="print"
          style={{
            flex: 1,
            background: "var(--cosmos-surface-alt, #F3F4F6)",
            color: "var(--cosmos-fg, #111827)",
            border: "none",
            borderRadius: 16,
            padding: 16,
            fontSize: 15,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {t(locale, "print")}
        </button>
        <button
          type="button"
          onClick={onShare}
          data-cosmos-action="share"
          data-share-text={resolvedShareText}
          style={{
            flex: 1,
            background: "var(--cosmos-button-bg, #111827)",
            color: "var(--cosmos-button-fg, #fff)",
            border: "none",
            borderRadius: 16,
            padding: 16,
            fontSize: 15,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {t(locale, "share")}
        </button>
      </div>
    </div>
  );
}
