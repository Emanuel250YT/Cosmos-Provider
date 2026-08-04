export interface TransferPartyRowProps {
  role: string;
  partyName: string;
  amount: string;
  avatarColor?: string;
}

/** One side of a transfer (sender or recipient) with an amount. */
export function TransferPartyRow({ role, partyName, amount, avatarColor = "#E9D9FF" }: TransferPartyRowProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: 16,
        background: "#fff",
        borderRadius: 14,
        fontFamily: "Helvetica, Arial, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: "50%", background: avatarColor, flexShrink: 0 }} />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{role}</span>
          <span style={{ fontSize: 12, color: "#9CA3AF" }}>{partyName}</span>
        </div>
      </div>
      <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{amount}</span>
    </div>
  );
}
