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

import type { Charge, OfframpDeposit, QuoteBreakdown, RampOrderData } from "@/core/types";
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

/**
 * Order summary rows (subtotal/fee/total-style breakdown) from a quote.
 *
 * The middle rows depend on who priced it. An oracle-priced quote shows the
 * mid rate and your spread, because those are the two numbers that produced
 * it. A provider-priced one (`source: "provider"`) shows the provider's own
 * fee instead and no spread row — the engine applied none, and rendering
 * "0.00%" there would imply the rail is free.
 */
export function quoteToSummaryRows(quote: QuoteBreakdown): SummaryRowProps[] {
  const rows: SummaryRowProps[] = [
    { label: `${quote.asset} amount`, value: quote.cryptoAmount.toString() },
    { label: "Rate", value: `${formatFiat(quote.effectiveRate, quote.currency)} / ${quote.asset}` },
  ];
  if (quote.fee && quote.fee.amount > 0) {
    rows.push({ label: "Provider fee", value: `${quote.fee.amount} ${quote.fee.currency}` });
  } else if (quote.source !== "provider" && quote.spread > 0) {
    rows.push({ label: "Fee", value: `${(quote.spread * 100).toFixed(2)}%` });
  }
  rows.push({ label: "Total", value: formatFiat(quote.fiatAmount, quote.currency), size: 18, weight: 700 });
  return rows;
}

/**
 * The rows a seller must act on to fund an offramp order: exact amount,
 * address, memo, and network.
 *
 * Every one of these is copyable and none are truncated away, because each
 * is a way to lose the funds — a transfer to the right address on the wrong
 * chain, or without the memo that identifies it in a pooled account, is
 * generally not recoverable. The memo row is labelled as required when the
 * provider gave one, rather than being presented as an optional extra.
 */
export function offrampDepositToDetailRows(deposit: OfframpDeposit): DetailRowProps[] {
  const rows: DetailRowProps[] = [
    { label: "Send exactly", value: `${deposit.amount} ${deposit.asset}` },
    { label: "To address", value: deposit.address, copyable: true },
  ];
  if (deposit.memo) {
    rows.push({ label: `Memo (required)`, value: deposit.memo, copyable: true, valueColor: "#B45309" });
  }
  if (deposit.network) rows.push({ label: "Network", value: deposit.chainId ?? deposit.network });
  if (deposit.fiatAmount !== undefined && deposit.currency) {
    rows.push({ label: "You receive", value: formatFiat(deposit.fiatAmount, deposit.currency) });
  }
  if (deposit.reference) rows.push({ label: "Reference", value: deposit.reference, copyable: true });
  if (deposit.expiresAt) rows.push({ label: "Expires", value: new Date(deposit.expiresAt).toLocaleString() });
  return rows;
}

/**
 * Transaction-detail rows (status, id, method, dates) for a ramp order.
 *
 * `settlementTxId` is chain-agnostic at the SDK level (`SettlementFn` can
 * release on whatever network the caller wires up), so this doesn't assume
 * a block explorer on its own — pass `settlementTxUrl` to make the
 * "Settlement Tx" row clickable, e.g.
 * `(txId) => \`https://stellar.expert/explorer/testnet/tx/${txId}\`` for a
 * real Stellar release. Return `undefined` from it to leave a given id as
 * plain text (e.g. one that isn't a real on-chain tx, like a simulated
 * fallback id).
 */
export function rampOrderToDetailRows(order: RampOrderData, options?: { settlementTxUrl?: (txId: string) => string | undefined }): DetailRowProps[] {
  const rows: DetailRowProps[] = [
    { label: "Order ID", value: order.id },
    { label: "Status", value: order.status, valueColor: STATUS_COLOR[order.status] ?? "var(--cosmos-fg, #111827)", capitalize: true },
    { label: "Provider", value: order.provider, capitalize: true },
  ];
  if (order.chargeId) rows.push({ label: "Payment ID", value: order.chargeId });
  if (order.charge?.method) rows.push({ label: "Method", value: order.charge.method, capitalize: true });
  if (order.settlementTxId) rows.push({ label: "Settlement Tx", value: order.settlementTxId, href: options?.settlementTxUrl?.(order.settlementTxId), copyable: true });
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
  if (order.status) rows.push({ label: "Status", value: order.status, valueColor: STATUS_COLOR[order.status] ?? "var(--cosmos-fg, #111827)", capitalize: true });
  if (order.sourceAsset && order.targetAsset) rows.push({ label: "Pair", value: `${order.sourceAsset} → ${order.targetAsset}` });
  if (order.amountInFiat) rows.push({ label: "Amount", value: order.amountInFiat });
  if (order.exchangeRate) rows.push({ label: "Rate", value: order.exchangeRate });
  if (order.trackingCode) rows.push({ label: "Tracking Code", value: order.trackingCode });
  if (order.createdAt) rows.push({ label: "Created", value: new Date(order.createdAt).toLocaleString() });
  return rows;
}
