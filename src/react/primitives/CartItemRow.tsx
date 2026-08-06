export interface CartItemRowProps {
  name: string;
  qty: number | string;
  price: string;
  imageUrl?: string;
}

/** A line item in a cart/order summary: thumbnail, name, quantity, price. */
export function CartItemRow({ name, qty, price, imageUrl }: CartItemRowProps) {
  return (
    <div style={{ display: "flex", gap: 12, paddingBottom: 16, marginBottom: 16, borderBottom: "1px solid #EEF0F3", fontFamily: "Helvetica, Arial, sans-serif" }}>
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 8,
          background: imageUrl ? undefined : "repeating-linear-gradient(45deg,#E5E7EB,#E5E7EB 6px,#EDEEF0 6px,#EDEEF0 12px)",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {imageUrl ? <img src={imageUrl} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 14, color: "#111827", fontWeight: 600, lineHeight: 1.3 }}>{name}</span>
        <span style={{ fontSize: 13, color: "#6B7280" }}>Qty : {qty}</span>
        <span style={{ fontSize: 14, color: "#111827", fontWeight: 700, marginTop: 2 }}>{price}</span>
      </div>
    </div>
  );
}
