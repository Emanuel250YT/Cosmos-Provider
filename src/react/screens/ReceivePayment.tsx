"use client";

import { useEffect, useState } from "react";
import { QRCode, type QRCodeProps } from "../primitives/QRCode";
import { DetailRow, type DetailRowProps } from "../primitives/DetailRow";
import { screenCardStyle } from "./shared";
import { t, type Locale } from "../i18n";

export interface ReceivePaymentProps {
  title?: string;
  amount: string;
  /** Live status pill (e.g. "Waiting for payment") shown under the amount. Omit to skip it entirely. */
  statusLabel?: string;
  statusColor?: string;
  /** QR to scan — pass `src` (server-rendered) or `value` (client-rendered). Omit when there's nothing scannable (e.g. a link-only charge) and let `paymentLink` drive an auto-generated QR instead. */
  qr?: Pick<QRCodeProps, "src" | "value">;
  /**
   * Marks `qr` as encoding `paymentLink` itself rather than a direct-pay
   * code (PIX and the like) — shows a small "Continue from your phone"
   * caption under the QR instead of the fixed "Scan to pay" title. Only
   * needed when you pre-render the link's QR yourself (server-side, passing
   * `qr.src`); when `qr` is omitted and `paymentLink` is set, this is
   * inferred automatically and the QR renders client-side from `paymentLink`.
   */
  qrIsPaymentLink?: boolean;
  /** Shown instead of (or alongside) the QR for hosted-checkout charges. */
  paymentLink?: string;
  paymentLinkLabel?: string;
  /**
   * Label the payment-link button switches to once it has been opened. See
   * {@link paymentLinkLockMs}.
   */
  paymentLinkOpenedLabel?: string;
  /**
   * How long the payment-link button stays disabled after it's clicked, in
   * ms (default 30s; `0` disables the lock). Opening a hosted checkout
   * several times over leaves the buyer with a pile of tabs racing on the
   * same charge, so the button locks itself for one checkout attempt and
   * then comes back in case they closed the tab or the payment bounced.
   */
  paymentLinkLockMs?: number;
  /** Extra detail rows below the QR — order id, expiry, method... */
  rows?: DetailRowProps[];
  onCopyCode?: () => void;
  copyLabel?: string;
  locale?: Locale;
}

/** "Scan to pay" screen: a real payment QR (e.g. PIX) or, for link-based checkouts, a QR of the link itself with a small "continue from your phone" caption. Amount, live status, and order details round it out. Colors are set via `--cosmos-*` CSS custom properties (with light-mode fallbacks baked in), so a page that defines dark-mode overrides for them re-themes this automatically. */
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
  paymentLinkOpenedLabel = t(locale, "paymentLinkOpened"),
  paymentLinkLockMs = 30_000,
  rows,
  onCopyCode,
  copyLabel = t(locale, "copyCode"),
}: ReceivePaymentProps) {
  const autoLinkQr = !qr && paymentLink ? { value: paymentLink } : undefined;
  const effectiveQr = qr ?? autoLinkQr;
  const isLinkQr = qrIsPaymentLink || (!qr && !!autoLinkQr);
  const resolvedTitle = title ?? t(locale, "scanToPay");

  // One checkout attempt at a time — see `paymentLinkLockMs`. Only takes
  // effect once hydrated; a statically rendered page always ships the link
  // unlocked, and the `data-cosmos-payment-link` attribute below is the hook
  // for wiring the same behavior there.
  const [linkLocked, setLinkLocked] = useState(false);
  useEffect(() => {
    if (!linkLocked || paymentLinkLockMs <= 0) return;
    const timer = setTimeout(() => setLinkLocked(false), paymentLinkLockMs);
    return () => clearTimeout(timer);
  }, [linkLocked, paymentLinkLockMs]);

  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "var(--cosmos-panel, #fff)", borderRadius: 24, padding: 20, color: "var(--cosmos-fg, #111827)" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{resolvedTitle}</div>
        <div style={{ fontSize: 32, fontWeight: 800, marginTop: 8 }}>{amount}</div>
        {statusLabel ? (
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
        ) : null}
      </div>

      {effectiveQr ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: 20 }}>
          <div style={{ background: "#fff", border: "1px solid var(--cosmos-border, #E5E7EB)", borderRadius: 16, padding: 16 }}>
            <QRCode {...effectiveQr} size={220} />
          </div>
          {isLinkQr ? (
            <div style={{ fontSize: 12, color: "var(--cosmos-muted, #9CA3AF)", marginTop: 10, textAlign: "center" }}>{t(locale, "continueFromPhone")}</div>
          ) : null}
        </div>
      ) : null}

      {paymentLink ? (
        <a
          href={paymentLink}
          target="_blank"
          rel="noopener noreferrer"
          data-cosmos-payment-link=""
          data-locked-label={paymentLinkOpenedLabel}
          data-lock-ms={paymentLinkLockMs}
          aria-disabled={linkLocked || undefined}
          onClick={(event) => {
            if (linkLocked) {
              event.preventDefault();
              return;
            }
            if (paymentLinkLockMs > 0) setLinkLocked(true);
          }}
          style={{
            display: "block",
            textAlign: "center",
            width: "100%",
            boxSizing: "border-box",
            background: linkLocked ? "var(--cosmos-surface-alt, #F3F4F6)" : "var(--cosmos-button-bg, #111827)",
            color: linkLocked ? "var(--cosmos-muted, #9CA3AF)" : "var(--cosmos-button-fg, #fff)",
            borderRadius: 16,
            padding: 16,
            fontSize: 15,
            fontWeight: 700,
            marginTop: 20,
            textDecoration: "none",
            cursor: linkLocked ? "default" : "pointer",
            pointerEvents: linkLocked ? "none" : undefined,
          }}
        >
          {linkLocked ? paymentLinkOpenedLabel : paymentLinkLabel}
        </a>
      ) : null}

      {onCopyCode ? (
        <button
          type="button"
          onClick={onCopyCode}
          style={{
            width: "100%",
            background: "var(--cosmos-surface-alt, #F3F4F6)",
            color: "var(--cosmos-fg, #111827)",
            border: "none",
            borderRadius: 16,
            padding: 14,
            fontSize: 14,
            fontWeight: 700,
            marginTop: 10,
            cursor: "pointer",
          }}
        >
          {copyLabel}
        </button>
      ) : null}

      {rows?.length ? (
        <div style={{ marginTop: 20, paddingTop: 12, borderTop: "1px dashed var(--cosmos-border, #E5E7EB)" }}>
          {rows.map((row, i) => (
            <DetailRow key={i} {...row} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
