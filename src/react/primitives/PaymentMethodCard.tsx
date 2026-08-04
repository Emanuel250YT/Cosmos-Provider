import type { ReactNode } from "react";

export interface PaymentMethodCardProps {
  iconLabel: string;
  iconBg: string;
  title: string;
  subtitle: string;
  selected?: boolean;
  radioColor?: string;
  bg?: string;
  /** Expanded content (e.g. an inline confirmation panel) shown below the card when selected. */
  children?: ReactNode;
  onSelect?: () => void;
}

/** A selectable payment/withdraw method card (radio row + icon badge). */
export function PaymentMethodCard({
  iconLabel,
  iconBg,
  title,
  subtitle,
  selected = false,
  radioColor = "#D1D5DB",
  bg = "#fff",
  children,
  onSelect,
}: PaymentMethodCardProps) {
  return (
    <div>
      <div
        onClick={onSelect}
        role={onSelect ? "button" : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: 16,
          borderRadius: 16,
          background: bg,
          fontFamily: "Helvetica, Arial, sans-serif",
          cursor: onSelect ? "pointer" : undefined,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: iconBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 700,
              fontSize: 13,
              flexShrink: 0,
            }}
          >
            {iconLabel}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: "#111827" }}>{title}</span>
            <span style={{ fontSize: 12, color: "#9CA3AF" }}>{subtitle}</span>
          </div>
        </div>
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
          {selected ? <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#111827" }} /> : null}
        </div>
      </div>
      {children}
    </div>
  );
}
