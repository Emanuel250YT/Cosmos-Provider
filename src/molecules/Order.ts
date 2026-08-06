/**
 * Molecule: Order — an onramp/offramp order with high-level helpers
 * (normalized deposit instructions, PIX QR, status polling).
 */

import { TERMINAL_ORDER_STATUSES, type OrderStatus } from "@/atoms/constants";
import { EtherfuseError } from "@/atoms/errors";
import type {
  APICreateOrderResult,
  APIOrder,
  DepositInstructions,
  WithdrawInstructions,
} from "@/types/index";
import type { EtherfuseClient } from "@/client/EtherfuseClient";
import { Base } from "@/molecules/Base";
import { Pix, PixQr } from "@/molecules/Pix";

/**
 * Looks up the deposit instructions in the raw payload, tolerating the
 * different field names per rail (SPEI uses `depositClabe`; PIX
 * exposes the "copia e cola" BR Code).
 */
export function extractDeposit(raw: Record<string, unknown>): DepositInstructions | null {
  const str = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  const pixCode =
    str("depositPixQrCode") ??
    str("depositPixCode") ??
    str("depositPixCopiaECola") ??
    str("pixCopiaECola") ??
    str("pixQrCode") ??
    str("pixCode") ??
    str("brCode");

  const clabe = str("depositClabe");
  if (!pixCode && !clabe) return null;

  return {
    method: pixCode ? "pix" : "spei",
    amount: str("depositAmount") ?? str("amountInFiat"),
    pixCode,
    clabe,
    bankName: str("depositBankName"),
    accountHolder: str("depositAccountHolder"),
  };
}

export class Order extends Base<APIOrder> {
  /** This order's id in Etherfuse. */
  get id(): string {
    return this.raw.orderId;
  }

  /** Current status, as reported by the API. Use {@link fetch} to refresh it. */
  get status(): OrderStatus | undefined {
    return this.raw.status;
  }

  /** `true` if this order buys crypto with fiat. */
  get isOnramp(): boolean {
    return this.raw.orderType === "onramp";
  }

  /** `true` if this order sells crypto for fiat. */
  get isOfframp(): boolean {
    return this.raw.orderType === "offramp";
  }

  /** `true` once the order reaches a final status. */
  get isTerminal(): boolean {
    return this.status !== undefined && TERMINAL_ORDER_STATUSES.includes(this.status);
  }

  /** Etherfuse-branded status page to show the end user. */
  get statusPage(): string | undefined {
    return this.raw.statusPage;
  }

  /** Normalized deposit instructions (onramps): PIX or SPEI. */
  get deposit(): DepositInstructions | null {
    return extractDeposit(this.raw);
  }

  /**
   * Creates a {@link PixQr} from the order's PIX code.
   * Returns `null` if the order has no PIX instructions (e.g. SPEI/MXN).
   */
  createPixQr(): PixQr | null {
    const code = this.deposit?.pixCode;
    return code ? Pix.fromCode(code, { validate: false }) : null;
  }

  /** Re-reads the order from the API and returns a fresh instance. */
  fetch(): Promise<Order> {
    return this.client.orders.fetch(this.id);
  }

  /** Cancels the order. */
  cancel(): Promise<unknown> {
    return this.client.orders.cancel(this.id);
  }

  /**
   * Polls until the order reaches `status` (or any terminal status,
   * so it doesn't wait forever on a failed order).
   */
  async waitForStatus(
    status: OrderStatus,
    { intervalMs = 5_000, timeoutMs = 600_000 }: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<Order> {
    const deadline = Date.now() + timeoutMs;
    let current: Order = this;
    for (;;) {
      if (current.status === status) return current;
      if (current.isTerminal) {
        throw new EtherfuseError(
          `Order ${this.id} ended in "${current.status}" before reaching "${status}".`,
        );
      }
      if (Date.now() >= deadline) {
        throw new EtherfuseError(
          `Timed out waiting for order ${this.id} to reach "${status}" (last status: "${current.status}").`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      current = await this.fetch();
    }
  }
}

/**
 * Result of `client.orders.create(...)`: the API returns a summary
 * (not the full order), with the payment instructions.
 */
export class OrderReceipt extends Base<APICreateOrderResult & Record<string, unknown>> {
  readonly orderId: string;
  readonly direction: "onramp" | "offramp" | "unknown";
  /** Onramps: deposit instructions (PIX or SPEI). */
  readonly deposit: DepositInstructions | null;
  /** Stellar/anchor offramps: withdrawal data. */
  readonly withdraw: WithdrawInstructions | null;

  constructor(client: EtherfuseClient, raw: APICreateOrderResult & Record<string, unknown>) {
    super(client, raw);

    const onramp = (raw.onramp ?? null) as Record<string, unknown> | null;
    const offramp = (raw.offramp ?? null) as Record<string, unknown> | null;
    const flat = raw as Record<string, unknown>;
    const source = onramp ?? offramp ?? flat;

    const id = source["orderId"] ?? flat["orderId"];
    if (typeof id !== "string") {
      throw new EtherfuseError("The create order response doesn't contain an orderId.");
    }
    this.orderId = id;
    this.direction = onramp ? "onramp" : offramp ? "offramp" : "unknown";
    this.deposit = extractDeposit(source) ?? extractDeposit(flat);
    this.withdraw = offramp
      ? {
          anchorAccount: (offramp["withdrawAnchorAccount"] as string | null) ?? null,
          memo: (offramp["withdrawMemo"] as string | null) ?? null,
          memoType: (offramp["withdrawMemoType"] as string | null) ?? null,
        }
      : null;
  }

  /** Deposit PIX QR, or `null` if the order isn't PIX. */
  createPixQr(): PixQr | null {
    const code = this.deposit?.pixCode;
    return code ? Pix.fromCode(code, { validate: false }) : null;
  }

  /** Fetches the full order from the API. */
  fetch(): Promise<Order> {
    return this.client.orders.fetch(this.orderId);
  }
}
