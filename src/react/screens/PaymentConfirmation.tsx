import { DetailRow, type DetailRowProps } from "../primitives/DetailRow";
import { screenCardStyle } from "./shared";

export interface PaymentConfirmationProps {
  itemTitle: string;
  itemSubtitle: string;
  /** Rows rendered as `DetailRow`s, in order — e.g. amount, status, bill id, then payment method, date, time, then tax and total. */
  rows: Array<DetailRowProps>;
  onShare?: () => void;
}

/** "Payment success" summary card with a share action. */
export function PaymentConfirmation({ itemTitle, itemSubtitle, rows, onShare }: PaymentConfirmationProps) {
  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "#F7F7F8", borderRadius: 24, paddingBottom: 24, color: "#111827" }}>
      <div style={{ padding: "16px 20px" }}>
        <div style={{ fontSize: 28, fontWeight: 800, marginTop: 8 }}>Payment Success!</div>
        <div style={{ fontSize: 14, color: "#6B7280", marginTop: 6 }}>Your payment has been successfully done</div>

        <div style={{ background: "#fff", borderRadius: 16, padding: 16, marginTop: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingBottom: 14,
              borderBottom: "1px solid #F0F0F1",
              marginBottom: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background: "repeating-linear-gradient(45deg,#E5E7EB,#E5E7EB 4px,#EDEEF0 4px,#EDEEF0 8px)",
                }}
              />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 15, fontWeight: 700 }}>{itemTitle}</span>
                <span style={{ fontSize: 12, color: "#9CA3AF" }}>{itemSubtitle}</span>
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
            background: "#111827",
            color: "#fff",
            border: "none",
            borderRadius: 16,
            padding: 16,
            fontSize: 16,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Share
        </button>
      </div>
    </div>
  );
}
