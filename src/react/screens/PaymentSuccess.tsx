import { screenCardStyle } from "./shared";
import { t, type Locale } from "../i18n";

export interface PaymentSuccessProps {
  amountPaid: string;
  merchantInitials: string;
  merchantName: string;
  merchantAccentColor?: string;
  merchantAccentBg?: string;
  totalPayment: string;
  taxLabel: string;
  taxAmount: string;
  cashbackNote?: string;
  paymentMethod: string;
  date: string;
  time: string;
  paymentTotal: string;
  onDone?: () => void;
  locale?: Locale;
}

/** Full "payment successful" receipt with an optional cashback callout. */
export function PaymentSuccess({
  locale = "en",
  amountPaid,
  merchantInitials,
  merchantName,
  merchantAccentColor = "#D9531E",
  merchantAccentBg = "#FDECD8",
  totalPayment,
  taxLabel,
  taxAmount,
  cashbackNote,
  paymentMethod,
  date,
  time,
  paymentTotal,
  onDone,
}: PaymentSuccessProps) {
  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "#F4F6F5", borderRadius: 24, padding: 20, color: "#111827" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: 12 }}>
        <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: "#fff", fontSize: 22, fontWeight: 700 }}>✓</span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#0D9488", marginTop: 10 }}>{t(locale, "paymentSuccessful")}</div>
        <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{amountPaid}</div>
      </div>

      <div style={{ background: "#fff", borderRadius: 16, padding: 20, marginTop: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingBottom: 16, borderBottom: "1px dashed #E5E7EB" }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: merchantAccentBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              color: merchantAccentColor,
            }}
          >
            {merchantInitials}
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 10, textAlign: "center" }}>{merchantName}</div>
        </div>
        <div style={{ paddingTop: 14, display: "flex", flexDirection: "column", gap: 4 }}>
          <Row label={t(locale, "totalPayment")} value={totalPayment} />
          <Row label={taxLabel} value={taxAmount} />
          {cashbackNote ? (
            <div style={{ background: "#DDF3E8", color: "#0D9488", fontSize: 13, fontWeight: 600, borderRadius: 10, padding: "10px 12px", marginTop: 8 }}>{cashbackNote}</div>
          ) : null}
          <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", marginTop: 14, marginBottom: 6 }}>{t(locale, "transactionDetails")}</div>
          <Row label={t(locale, "paymentMethod")} value={paymentMethod} />
          <Row label={t(locale, "status")} value={t(locale, "success")} valueColor="#16A34A" />
          <Row label={t(locale, "date")} value={date} />
          <Row label={t(locale, "time")} value={time} />
          <div style={{ borderTop: "1px dashed #E5E7EB", margin: "10px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15 }}>
            <span style={{ fontWeight: 700 }}>{t(locale, "paymentTotal")}</span>
            <span style={{ fontWeight: 800 }}>{paymentTotal}</span>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onDone}
        style={{ width: "100%", background: "#8FC7BC", border: "none", borderRadius: 16, padding: 16, fontSize: 15, fontWeight: 700, color: "#fff", marginTop: 20, cursor: "pointer" }}
      >
        {t(locale, "done")}
      </button>
    </div>
  );
}

function Row({ label, value, valueColor = "#111827" }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "6px 0" }}>
      <span style={{ color: "#9CA3AF" }}>{label}</span>
      <span style={{ fontWeight: 600, color: valueColor }}>{value}</span>
    </div>
  );
}
