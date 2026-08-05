import { DetailRow, type DetailRowProps } from "../primitives/DetailRow";
import { screenCardStyle } from "./shared";
import { t, type Locale } from "../i18n";

export interface PaymentConfirmationProps {
  itemTitle: string;
  itemSubtitle: string;
  /** Rows rendered as `DetailRow`s, in order — e.g. amount, status, bill id, then payment method, date, time, then tax and total. */
  rows: Array<DetailRowProps>;
  onShare?: () => void;
  locale?: Locale;
}

/** "Payment success" summary card with a share action. */
export function PaymentConfirmation({ itemTitle, itemSubtitle, rows, onShare, locale = "en" }: PaymentConfirmationProps) {
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
                  background: "repeating-linear-gradient(45deg, var(--cosmos-border, #E5E7EB), var(--cosmos-border, #E5E7EB) 4px, var(--cosmos-bg-soft, #EDEEF0) 4px, var(--cosmos-bg-soft, #EDEEF0) 8px)",
                }}
              />
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

      <div style={{ padding: "0 20px" }}>
        <button
          type="button"
          onClick={onShare}
          style={{
            width: "100%",
            background: "var(--cosmos-button-bg, #111827)",
            color: "var(--cosmos-button-fg, #fff)",
            border: "none",
            borderRadius: 16,
            padding: 16,
            fontSize: 16,
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
