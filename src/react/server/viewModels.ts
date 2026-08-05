/**
 * Maps SDK responses — `RampOrderData` (CosmosRamp/CosmosClient), Etherfuse's
 * `Order`/`OrderReceipt`, `DepositInstructions` — into the plain, typed props
 * `cosmos-providers/react` components expect.
 *
 * Server-only by convention: these run right after the calls that produced
 * the data they normalize (`ramp.onramp()`, `ramp.getOrder()`,
 * `client.orders.create()`...), which need provider API keys. Nothing here
 * touches the network itself — it's pure formatting — but keeping it behind
 * `cosmos-providers/react/server` keeps the client bundle free of the
 * provider SDKs these types come from.
 */

import type { Charge, QuoteBreakdown, RampOrderData } from "@/core/types";
import type { APIOrder, DepositInstructions } from "@/types/index";
import type { SummaryRowProps } from "../primitives/SummaryRow";
import type { DetailRowProps } from "../primitives/DetailRow";
import type { QRCodeProps } from "../primitives/QRCode";
import { renderQrDataUrl } from "./qr";

const STATUS_COLOR: Record<string, string> = {
  created: "#9CA3AF",
  paid: "#16A34A",
  settling: "#F59E0B",
  completed: "#16A34A",
  failed: "#DC2626",
  expired: "#DC2626",
  canceled: "#DC2626",
};

function formatFiat(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Order summary rows (subtotal/fee/total-style breakdown) from a quote. */
export function quoteToSummaryRows(quote: QuoteBreakdown): SummaryRowProps[] {
  const feeRate = quote.effectiveRate - quote.rate;
  return [
    { label: `${quote.asset} amount`, value: quote.cryptoAmount.toString() },
    { label: "Rate", value: formatFiat(quote.rate, quote.currency) },
    ...(feeRate !== 0 ? [{ label: "Spread", value: `${(quote.spread * 100).toFixed(2)}%` }] : []),
    { label: "Total", value: formatFiat(quote.fiatAmount, quote.currency), size: 18, weight: 700 },
  ];
}

/** Transaction-detail rows (status, id, method, dates) for a ramp order. */
export function rampOrderToDetailRows(order: RampOrderData): DetailRowProps[] {
  const rows: DetailRowProps[] = [
    { label: "Order ID", value: order.id },
    { label: "Status", value: order.status, valueColor: STATUS_COLOR[order.status] ?? "var(--cosmos-fg, #111827)" },
    { label: "Provider", value: order.provider },
  ];
  if (order.chargeId) rows.push({ label: "Payment ID", value: order.chargeId });
  if (order.charge?.method) rows.push({ label: "Method", value: order.charge.method });
  if (order.settlementTxId) rows.push({ label: "Settlement Tx", value: order.settlementTxId });
  rows.push({ label: "Created", value: new Date(order.createdAt).toLocaleString() });
  return rows;
}

/**
 * QR props for a ramp order's charge, ready to spread into `<QRCode>`.
 * Returns `null` when the charge has no scannable payload (e.g. a payment
 * link or transfer-only charge).
 */
export async function chargeToQrProps(charge: Charge | undefined, options?: { width?: number }): Promise<Pick<QRCodeProps, "src"> | null> {
  if (!charge) return null;
  if (charge.qrBase64) {
    return { src: charge.qrBase64.startsWith("data:") ? charge.qrBase64 : `data:image/png;base64,${charge.qrBase64}` };
  }
  if (charge.qr) {
    return { src: await renderQrDataUrl(charge.qr, { width: options?.width }) };
  }
  return null;
}

/** QR props for an onramp's normalized deposit instructions (PIX only — SPEI/CLABE has no QR). */
export async function depositInstructionsToQrProps(deposit: DepositInstructions, options?: { width?: number }): Promise<Pick<QRCodeProps, "src"> | null> {
  if (deposit.method !== "pix" || !deposit.pixCode) return null;
  return { src: await renderQrDataUrl(deposit.pixCode, { width: options?.width }) };
}

/** Transaction-detail rows for an Etherfuse `APIOrder` (onramp/offramp). */
export function apiOrderToDetailRows(order: APIOrder): DetailRowProps[] {
  const rows: DetailRowProps[] = [{ label: "Order ID", value: order.orderId }];
  if (order.status) rows.push({ label: "Status", value: order.status, valueColor: STATUS_COLOR[order.status] ?? "var(--cosmos-fg, #111827)" });
  if (order.sourceAsset && order.targetAsset) rows.push({ label: "Pair", value: `${order.sourceAsset} → ${order.targetAsset}` });
  if (order.amountInFiat) rows.push({ label: "Amount", value: order.amountInFiat });
  if (order.exchangeRate) rows.push({ label: "Rate", value: order.exchangeRate });
  if (order.trackingCode) rows.push({ label: "Tracking Code", value: order.trackingCode });
  if (order.createdAt) rows.push({ label: "Created", value: new Date(order.createdAt).toLocaleString() });
  return rows;
}
