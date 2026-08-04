export type PaymentOptionBadge = "paypal" | "google-pay" | "cash";

export interface PaymentOptionRowProps {
  label: string;
  selected?: boolean;
  radioColor?: string;
  badge?: PaymentOptionBadge;
  onSelect?: () => void;
}

/** A selectable checkout payment option row, with an optional brand badge. */
export function PaymentOptionRow({ label, selected = false, radioColor = "#D1D5DB", badge, onSelect }: PaymentOptionRowProps) {
  return (
    <div
      onClick={onSelect}
      role={onSelect ? "button" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "20px 24px",
        border: "1px solid #E5E7EB",
        borderRadius: 12,
        background: "#fff",
        gap: 16,
        fontFamily: "Helvetica, Arial, sans-serif",
        cursor: onSelect ? "pointer" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            border: `2px solid ${radioColor}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {selected ? <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#4F46E5" }} /> : null}
        </div>
        <span style={{ fontSize: 15, color: "#111827", fontWeight: 600 }}>{label}</span>
      </div>
      {badge === "paypal" ? <span style={{ fontWeight: 700, fontSize: 15, color: "#003087", fontStyle: "italic" }}>PayPal</span> : null}
      {badge === "google-pay" ? <span style={{ fontWeight: 600, fontSize: 15, color: "#5F6368" }}>G Pay</span> : null}
      {badge === "cash" ? (
        <div style={{ width: 28, height: 20, borderRadius: 3, background: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>$</span>
        </div>
      ) : null}
    </div>
  );
}
