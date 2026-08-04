import { screenCardStyle } from "./shared";

export interface OrderThankYouProps {
  customerFirstName: string;
  orderNumber: string;
  orderDate: string;
  totalItems: string;
  price: string;
  shipping?: string;
  totalPrice: string;
  supportPhone?: string;
  onBack?: () => void;
  onDownload?: () => void;
  onBackToHome?: () => void;
}

/** Order confirmation with a details breakdown and a support contact line. */
export function OrderThankYou({
  customerFirstName,
  orderNumber,
  orderDate,
  totalItems,
  price,
  shipping = "FREE",
  totalPrice,
  supportPhone,
  onBack,
  onDownload,
  onBackToHome,
}: OrderThankYouProps) {
  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "#F4F6F5", borderRadius: 24, padding: 20, color: "#111827" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button type="button" onClick={onBack} aria-label="Back" style={{ background: "none", border: "none", fontSize: 18, cursor: onBack ? "pointer" : "default" }}>
          ←
        </button>
        <button type="button" onClick={onDownload} aria-label="Download" style={{ background: "none", border: "none", fontSize: 18, cursor: onDownload ? "pointer" : "default" }}>
          ↓
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: 16 }}>
        <div style={{ width: 76, height: 76, borderRadius: "50%", background: "#DCEEE9", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 44, height: 44, borderRadius: 8, border: "2px solid #0D9488", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: "#16A34A",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "absolute",
                top: -8,
                right: -8,
              }}
            >
              <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</span>
            </div>
          </div>
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 16 }}>Thank you, {customerFirstName}!</div>
        <div style={{ fontSize: 13, color: "#9CA3AF", marginTop: 4 }}>Your order has been processed successfully!</div>
      </div>

      <div style={{ background: "#fff", borderRadius: 16, padding: 20, marginTop: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Order details</div>
        <Row label="Number order" value={orderNumber} />
        <Row label="Order date" value={orderDate} />
        <Row label="Total items" value={totalItems} />
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 14, marginBottom: 6 }}>Details</div>
        <Row label="Price" value={price} />
        <Row label="Shipping" value={shipping} />
        <Row label="Total Price" value={totalPrice} />
      </div>

      {supportPhone ? (
        <div style={{ fontSize: 12, color: "#6B7280", marginTop: 16, lineHeight: 1.5 }}>
          Note: if you need help please contact customer service{" "}
          <a href={`tel:${supportPhone}`} style={{ color: "#0D9488", textDecoration: "underline" }}>
            {supportPhone}
          </a>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onBackToHome}
        style={{ width: "100%", background: "#8FC7BC", border: "none", borderRadius: 16, padding: 16, fontSize: 15, fontWeight: 700, color: "#fff", marginTop: 20, cursor: "pointer" }}
      >
        Back to Home
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "6px 0" }}>
      <span style={{ color: "#9CA3AF" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
