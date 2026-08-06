import { screenCardStyle } from "./shared";
import { t, type Locale } from "../i18n";

export interface TransactionDetailsProps {
  merchantInitials: string;
  merchantName: string;
  merchantAccentColor?: string;
  merchantAccentBg?: string;
  subtitle?: string;
  totalPaid: string;
  date: string;
  category: string;
  orderNumber: string;
  cardHolderName: string;
  cardLast4: string;
  onBackToHome?: () => void;
  onDownload?: () => void;
  locale?: Locale;
}

/** Receipt-style breakdown of a completed transaction. */
export function TransactionDetails({
  locale = "en",
  merchantInitials,
  merchantName,
  merchantAccentColor = "#B5384E",
  merchantAccentBg = "#FCE7EC",
  subtitle = t(locale, "onlinePayment"),
  totalPaid,
  date,
  category,
  orderNumber,
  cardHolderName,
  cardLast4,
  onBackToHome,
  onDownload,
}: TransactionDetailsProps) {
  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "#F4F6F5", borderRadius: 24, padding: 20, color: "#0F3D2E" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", paddingBottom: 12 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>{t(locale, "transactionDetails")}</span>
      </div>

      <div style={{ background: "#fff", borderRadius: 16, padding: 20, marginTop: 12 }}>
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
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 10 }}>{merchantName}</div>
          <div style={{ fontSize: 13, color: "#9CA3AF", marginTop: 2 }}>{subtitle}</div>
          <div style={{ fontSize: 13, color: "#9CA3AF", marginTop: 16 }}>{t(locale, "totalPaid")}</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#0D9488", marginTop: 4 }}>{totalPaid}</div>
        </div>
        <div style={{ paddingTop: 16, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", marginBottom: 6 }}>{t(locale, "transactionDetails")}</div>
          <Row label={t(locale, "date")} value={date} />
          <Row label={t(locale, "category")} value={category} />
          <Row label={t(locale, "orderNumberLabel")} value={orderNumber} />
          <div style={{ fontSize: 14, fontWeight: 600, color: "#111827", marginTop: 12, marginBottom: 8 }}>{t(locale, "cardHolder")}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#F4F6F5", borderRadius: 12, padding: "10px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "#0D9488",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {initials(cardHolderName)}
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{cardHolderName}</span>
                <span style={{ fontSize: 12, color: "#9CA3AF" }}>**** **** **** {cardLast4}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        <button
          type="button"
          onClick={onBackToHome}
          style={{ flex: 1, background: "#fff", border: "1px solid #D1D5DB", borderRadius: 16, padding: 14, fontSize: 14, fontWeight: 700, color: "#111827", cursor: "pointer" }}
        >
          {t(locale, "backToHome")}
        </button>
        <button
          type="button"
          onClick={onDownload}
          style={{ flex: 1, background: "#8FC7BC", border: "none", borderRadius: 16, padding: 14, fontSize: 14, fontWeight: 700, color: "#fff", cursor: "pointer" }}
        >
          {t(locale, "download")}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "6px 0" }}>
      <span style={{ color: "#9CA3AF" }}>{label}</span>
      <span style={{ fontWeight: 600, color: "#111827" }}>{value}</span>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}
