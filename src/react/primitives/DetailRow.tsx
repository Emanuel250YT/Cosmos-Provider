export interface DetailRowProps {
  label: string;
  value: string;
  valueColor?: string;
}

/** A label/value line for a transaction detail sheet (status, date, id...). */
export function DetailRow({ label, value, valueColor = "var(--cosmos-fg, #111827)" }: DetailRowProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 0",
        fontFamily: "Helvetica, Arial, sans-serif",
      }}
    >
      <span style={{ fontSize: 14, color: "var(--cosmos-muted, #9CA3AF)" }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, color: valueColor }}>{value}</span>
    </div>
  );
}
