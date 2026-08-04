import { screenCardStyle } from "./shared";

export interface AddCardFormValues {
  cardHolderName: string;
  cardNumber: string;
  expiryDate: string;
  cvv: string;
}

export interface AddCardFormProps {
  title?: string;
  defaultValues?: Partial<AddCardFormValues>;
  /** Preview text shown on the card art above the form. */
  cardPreviewName?: string;
  onBack?: () => void;
  onSubmit?: (values: AddCardFormValues) => void;
}

/** A "save a card" form with a live card-art preview. */
export function AddCardForm({ title = "Add Card", defaultValues, cardPreviewName = "Card holder", onBack, onSubmit }: AddCardFormProps) {
  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "#fff", borderRadius: 24, padding: 20, color: "#111827" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        {onBack ? (
          <button type="button" onClick={onBack} aria-label="Back" style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer" }}>
            ←
          </button>
        ) : (
          <span />
        )}
        <span style={{ fontSize: 18, fontWeight: 700 }}>{title}</span>
        <span />
      </div>

      <div
        style={{
          background: "linear-gradient(135deg,#FF9A56,#F2703C)",
          borderRadius: 16,
          padding: 20,
          height: 150,
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          boxShadow: "0 8px 20px rgba(242,112,60,0.35)",
          color: "#fff",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>{cardPreviewName}</span>
          <div style={{ display: "flex" }}>
            <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#EF4444", opacity: 0.9 }} />
            <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#F59E0B", opacity: 0.9, marginLeft: -8 }} />
          </div>
        </div>
        <div>
          <div style={{ fontSize: 15, letterSpacing: 2, fontWeight: 600 }}>{defaultValues?.cardNumber || "•••• •••• •••• ••••"}</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 10 }}>
            <span style={{ fontSize: 11, opacity: 0.85 }}>Exp {defaultValues?.expiryDate || "MM/YY"}</span>
            <div style={{ width: 26, height: 20, background: "rgba(255,255,255,0.25)", borderRadius: 3 }} />
          </div>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          onSubmit?.({
            cardHolderName: String(data.get("cardHolderName") || ""),
            cardNumber: String(data.get("cardNumber") || ""),
            expiryDate: String(data.get("expiryDate") || ""),
            cvv: String(data.get("cvv") || ""),
          });
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 24, marginBottom: 14 }}>Credit Card Info</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Card Holder Name" name="cardHolderName" defaultValue={defaultValues?.cardHolderName} />
          <Field label="Card number*" name="cardNumber" defaultValue={defaultValues?.cardNumber} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <div style={{ flex: "1 1 140px" }}>
              <Field label="Expiry Date MM/YY*" name="expiryDate" defaultValue={defaultValues?.expiryDate} />
            </div>
            <div style={{ flex: "1 1 140px" }}>
              <Field label="CVV" name="cvv" defaultValue={defaultValues?.cvv} type="password" />
            </div>
          </div>
        </div>

        <button
          type="submit"
          style={{ width: "100%", background: "#111827", color: "#fff", border: "none", borderRadius: 16, padding: 16, fontSize: 16, fontWeight: 700, marginTop: 28, cursor: "pointer" }}
        >
          Save
        </button>
      </form>
    </div>
  );
}

function Field({ label, name, defaultValue, type = "text" }: { label: string; name: string; defaultValue?: string; type?: string }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ fontSize: 12, color: "#9CA3AF" }}>{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        style={{ display: "block", width: "100%", boxSizing: "border-box", border: "1px solid #E5E7EB", borderRadius: 10, padding: "12px 14px", fontSize: 14, marginTop: 4 }}
      />
    </label>
  );
}
