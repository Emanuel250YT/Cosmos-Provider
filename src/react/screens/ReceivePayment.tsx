import { QRCode, type QRCodeProps } from "../primitives/QRCode";
import { DetailRow, type DetailRowProps } from "../primitives/DetailRow";
import { screenCardStyle } from "./shared";
import { t, type Locale } from "../i18n";

export interface ReceivePaymentProps {
  title?: string;
  amount: string;
  statusLabel: string;
  statusColor?: string;
  /** QR to scan — pass `src` (server-rendered) or `value` (client-rendered). Omit when there's nothing scannable (e.g. a link-only charge) and let `paymentLink` drive an auto-generated QR instead. */
  qr?: Pick<QRCodeProps, "src" | "value">;
  /**
   * Marks `qr` as encoding `paymentLink` itself rather than a direct-pay
   * code (PIX and the like) — swaps the default title to "Continue from
   * your phone". Only needed when you pre-render the link's QR yourself
   * (server-side, passing `qr.src`); when `qr` is omitted and `paymentLink`
   * is set, this is inferred automatically and the QR renders client-side
   * from `paymentLink`.
   */
  qrIsPaymentLink?: boolean;
  /** Shown instead of (or alongside) the QR for hosted-checkout charges. */
  paymentLink?: string;
  paymentLinkLabel?: string;
  /** Extra detail rows below the QR — order id, expiry, method... */
  rows?: DetailRowProps[];
  onCopyCode?: () => void;
  copyLabel?: string;
  locale?: Locale;
}

/** "Scan to pay" screen: a real payment QR (e.g. PIX) or, for link-based checkouts, a QR of the link itself so the buyer can continue from their phone. Amount, live status, and order details round it out. */
export function ReceivePayment({
  locale = "en",
  title,
  amount,
  statusLabel,
  statusColor = "#9CA3AF",
  qr,
  qrIsPaymentLink = false,
  paymentLink,
  paymentLinkLabel = t(locale, "openPaymentLink"),
  rows,
  onCopyCode,
  copyLabel = t(locale, "copyCode"),
}: ReceivePaymentProps) {
  const autoLinkQr = !qr && paymentLink ? { value: paymentLink } : undefined;
  const effectiveQr = qr ?? autoLinkQr;
  const isLinkQr = qrIsPaymentLink || (!qr && !!autoLinkQr);
  const resolvedTitle = title ?? (isLinkQr ? t(locale, "continueFromPhone") : t(locale, "scanToPay"));

  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "#fff", borderRadius: 24, padding: 20, color: "#111827" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{resolvedTitle}</div>
        <div style={{ fontSize: 32, fontWeight: 800, marginTop: 8 }}>{amount}</div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginTop: 8,
            padding: "4px 10px",
            borderRadius: 999,
            background: `${statusColor}1A`,
            color: statusColor,
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} />
          {statusLabel}
        </div>
      </div>

      {effectiveQr ? (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}>
          <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 16, padding: 16 }}>
            <QRCode {...effectiveQr} size={220} />
          </div>
        </div>
      ) : null}

      {paymentLink ? (
        <a
          href={paymentLink}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "block",
            textAlign: "center",
            width: "100%",
            boxSizing: "border-box",
            background: "#111827",
            color: "#fff",
            borderRadius: 16,
            padding: 16,
            fontSize: 15,
            fontWeight: 700,
            marginTop: 20,
            textDecoration: "none",
          }}
        >
          {paymentLinkLabel}
        </a>
      ) : null}

      {onCopyCode ? (
        <button
          type="button"
          onClick={onCopyCode}
          style={{ width: "100%", background: "#F3F4F6", color: "#111827", border: "none", borderRadius: 16, padding: 14, fontSize: 14, fontWeight: 700, marginTop: 10, cursor: "pointer" }}
        >
          {copyLabel}
        </button>
      ) : null}

      {rows?.length ? (
        <div style={{ marginTop: 20, paddingTop: 12, borderTop: "1px dashed #E5E7EB" }}>
          {rows.map((row, i) => (
            <DetailRow key={i} {...row} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
