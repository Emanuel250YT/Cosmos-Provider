export interface SummaryRowProps {
  label: string;
  value: string;
  size?: number | string;
  weight?: number | string;
  color?: string;
}

/** A label/value line for an order summary (subtotal, shipping, total...). */
export function SummaryRow({ label, value, size = 14, weight = 600, color = "var(--cosmos-fg, #111827)" }: SummaryRowProps) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontFamily: "Helvetica, Arial, sans-serif" }}>
      <span style={{ fontSize: 14, color: "var(--cosmos-muted, #374151)" }}>{label}</span>
      <span style={{ fontSize: size, fontWeight: weight, color }}>{value}</span>
    </div>
  );
}
