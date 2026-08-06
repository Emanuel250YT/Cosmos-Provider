export interface DetailRow2Props {
  label: string;
  value: string;
}

/** A confirmed field card: label on top, value below, with a check badge. */
export function DetailRow2({ label, value }: DetailRow2Props) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 14,
        padding: 14,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        fontFamily: "Helvetica, Arial, sans-serif",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 11, color: "#9CA3AF" }}>{label}</span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "#111827",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {value}
        </span>
      </div>
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "#7C3AED",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</span>
      </div>
    </div>
  );
}
