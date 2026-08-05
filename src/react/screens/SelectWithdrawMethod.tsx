import type { ReactNode } from "react";
import { PaymentMethodCard, type PaymentMethodCardProps } from "../primitives/PaymentMethodCard";
import { screenCardStyle } from "./shared";
import { t, type Locale } from "../i18n";

export interface WithdrawMethodOption extends PaymentMethodCardProps {
  /** Stable key for the list; falls back to `title` if omitted. */
  id?: string;
  group?: "cash" | "crypto";
}

export interface SelectWithdrawMethodProps {
  title?: string;
  subtitle?: string;
  cashSectionLabel?: string;
  cryptoSectionLabel?: string;
  methods: WithdrawMethodOption[];
  onBack?: () => void;
  locale?: Locale;
}

/** Method picker for withdrawing funds, grouped into cash and crypto rails. */
export function SelectWithdrawMethod({
  locale = "en",
  title = t(locale, "selectMethod"),
  subtitle,
  cashSectionLabel = t(locale, "cashPayment"),
  cryptoSectionLabel = t(locale, "cryptoPayment"),
  methods,
  onBack,
}: SelectWithdrawMethodProps) {
  const cash = methods.filter((m) => (m.group ?? "cash") === "cash");
  const crypto = methods.filter((m) => m.group === "crypto");

  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "#EEF0F2", borderRadius: 24, padding: 20, color: "#111827" }}>
      <button
        type="button"
        onClick={onBack}
        aria-label={t(locale, "back")}
        style={{ width: 36, height: 36, borderRadius: "50%", background: "#fff", border: "none", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, marginBottom: 24, cursor: onBack ? "pointer" : "default" }}
      >
        ←
      </button>
      <div style={{ fontSize: 24, fontWeight: 800, textAlign: "center" }}>{title}</div>
      {subtitle ? <div style={{ fontSize: 14, color: "#6B7280", textAlign: "center", marginTop: 8, lineHeight: 1.5 }}>{subtitle}</div> : null}

      {cash.length ? (
        <Section label={cashSectionLabel}>
          {cash.map((m, i) => (
            <PaymentMethodCard key={m.id ?? i} {...m} bg={m.bg ?? "#fff"} />
          ))}
        </Section>
      ) : null}

      {crypto.length ? (
        <Section label={cryptoSectionLabel}>
          {crypto.map((m, i) => (
            <PaymentMethodCard key={m.id ?? i} {...m} bg={m.bg ?? "#fff"} />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div style={{ fontSize: 13, color: "#6B7280", fontWeight: 600, margin: "24px 0 10px" }}>{label}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </>
  );
}
