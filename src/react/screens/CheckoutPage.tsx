import type { ReactNode } from "react";
import { PaymentOptionRow, type PaymentOptionBadge } from "../primitives/PaymentOptionRow";
import { CartItemRow, type CartItemRowProps } from "../primitives/CartItemRow";
import { SummaryRow, type SummaryRowProps } from "../primitives/SummaryRow";
import { t, type Locale } from "../i18n";

export interface CheckoutOption {
  id: string;
  label: string;
  badge?: PaymentOptionBadge;
}

export interface CheckoutPageProps {
  brandName: string;
  onCancelBooking?: () => void;
  options: CheckoutOption[];
  selectedOptionId: string;
  onSelectOption?: (id: string) => void;
  /** Rendered under the selected option's row — a card form, a QR code, etc. */
  selectedOptionContent?: ReactNode;
  cartItems: CartItemRowProps[];
  summaryRows: SummaryRowProps[];
  payLabel: string;
  onPay?: () => void;
  termsAccepted?: boolean;
  onTermsAcceptedChange?: (accepted: boolean) => void;
  locale?: Locale;
}

/** Two-column checkout: payment method selection + card cart/summary. */
export function CheckoutPage({
  locale = "en",
  brandName,
  onCancelBooking,
  options,
  selectedOptionId,
  onSelectOption,
  selectedOptionContent,
  cartItems,
  summaryRows,
  payLabel,
  onPay,
  termsAccepted,
  onTermsAcceptedChange,
}: CheckoutPageProps) {
  return (
    <div style={{ fontFamily: "Helvetica, Arial, sans-serif", background: "#F4F5F7", borderRadius: 24, color: "#111827" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px clamp(16px, 4vw, 48px)",
          background: "#fff",
          borderRadius: "24px 24px 0 0",
          borderBottom: "1px solid #EEF0F3",
        }}
      >
        <span style={{ fontSize: 20, fontWeight: 700 }}>{brandName}</span>
        {onCancelBooking ? (
          <button
            type="button"
            onClick={onCancelBooking}
            style={{ background: "none", border: "none", fontSize: 14, fontWeight: 600, textDecoration: "underline", color: "#DC2626", cursor: "pointer" }}
          >
            {t(locale, "cancelBooking")}
          </button>
        ) : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24, padding: "24px clamp(16px, 4vw, 48px)", alignItems: "start" }}>
        <div style={{ background: "#fff", borderRadius: 16, padding: 32, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{t(locale, "selectPaymentOption")}</div>
            <div style={{ fontSize: 14, color: "#6B7280", marginTop: 4 }}>{t(locale, "secureTransactions")}</div>
          </div>

          {options.map((option) =>
            option.id === selectedOptionId ? (
              <div key={option.id} style={{ border: "2px solid #4F46E5", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid #4F46E5", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#4F46E5" }} />
                    </div>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{option.label}</span>
                  </div>
                </div>
                {selectedOptionContent}
              </div>
            ) : (
              <PaymentOptionRow key={option.id} label={option.label} badge={option.badge} onSelect={onSelectOption ? () => onSelectOption(option.id) : undefined} />
            ),
          )}

          <button
            type="button"
            onClick={onPay}
            style={{ background: "#4F46E5", color: "#fff", border: "none", borderRadius: 10, padding: 16, fontSize: 16, fontWeight: 700, cursor: "pointer", marginTop: 8 }}
          >
            {payLabel}
          </button>
          {onTermsAcceptedChange ? (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <input type="checkbox" checked={!!termsAccepted} onChange={(e) => onTermsAcceptedChange(e.target.checked)} style={{ marginTop: 3 }} />
              <span style={{ fontSize: 13, color: "#374151" }}>{t(locale, "termsNotice")}</span>
            </label>
          ) : null}
        </div>

        <div style={{ background: "linear-gradient(135deg,#EEF2FF,#FDF2F8)", border: "1px solid #E5E7EB", borderRadius: 16, padding: 24 }}>
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>
            {t(locale, "yourCart")} <span style={{ color: "#4F46E5" }}>({cartItems.length})</span>
          </div>
          {cartItems.map((item, i) => (
            <CartItemRow key={i} {...item} />
          ))}
          <div style={{ background: "#fff", borderRadius: 10, padding: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{t(locale, "orderSummary")}</div>
            {summaryRows.map((row, i) => (
              <SummaryRow key={i} {...row} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
