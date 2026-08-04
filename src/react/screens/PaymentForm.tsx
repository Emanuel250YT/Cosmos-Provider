import { DetailRow2 } from "../primitives/DetailRow2";
import { screenCardStyle } from "./shared";

export interface PaymentFormProps {
  itemTitle: string;
  spotsLeftLabel?: string;
  trainingTime: string;
  coachName: string;
  sessionPrice: string;
  cardNumberMasked: string;
  expiryDate: string;
  cvvMasked?: string;
  payLabel: string;
  onPay?: () => void;
}

/** A payment method + card-details review screen, ending in a "Pay" CTA. */
export function PaymentForm({
  itemTitle,
  spotsLeftLabel,
  trainingTime,
  coachName,
  sessionPrice,
  cardNumberMasked,
  expiryDate,
  cvvMasked = "•••",
  payLabel,
  onPay,
}: PaymentFormProps) {
  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "#F7F7F8", borderRadius: 24, paddingBottom: 24, color: "#111827" }}>
      <div style={{ padding: "8px 20px" }}>
        <div style={{ fontSize: 13, color: "#6B7280", fontWeight: 600, marginBottom: 10 }}>Order</div>
        <div style={{ background: "#fff", borderRadius: 16, padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background: "repeating-linear-gradient(45deg,#E5E7EB,#E5E7EB 4px,#EDEEF0 4px,#EDEEF0 8px)",
                }}
              />
              <span style={{ fontSize: 15, fontWeight: 700 }}>{itemTitle}</span>
            </div>
            {spotsLeftLabel ? <div style={{ fontSize: 12, fontWeight: 700, color: "#7C3AED" }}>{spotsLeftLabel}</div> : null}
          </div>
          <div style={{ borderTop: "1px solid #F0F0F1" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
            <span style={{ color: "#6B7280" }}>Time</span>
            <span style={{ fontWeight: 600 }}>{trainingTime}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
            <span style={{ color: "#6B7280" }}>Coach name</span>
            <span style={{ fontWeight: 600 }}>{coachName}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
            <span style={{ color: "#6B7280" }}>Session price</span>
            <span style={{ fontWeight: 700 }}>{sessionPrice}</span>
          </div>
        </div>

        <div style={{ fontSize: 13, color: "#6B7280", fontWeight: 600, margin: "20px 0 10px" }}>Card details</div>
        <DetailRow2 label="Card Number" value={cardNumberMasked} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
          <div style={{ flex: "1 1 140px" }}>
            <DetailRow2 label="Exp. Date" value={expiryDate} />
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <DetailRow2 label="CVV" value={cvvMasked} />
          </div>
        </div>
      </div>

      <div style={{ padding: 20 }}>
        <button
          type="button"
          onClick={onPay}
          style={{ width: "100%", background: "#111827", color: "#fff", border: "none", borderRadius: 16, padding: 16, fontSize: 16, fontWeight: 700, cursor: "pointer" }}
        >
          {payLabel}
        </button>
      </div>
    </div>
  );
}
