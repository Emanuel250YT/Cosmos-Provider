/**
 * Molecule: Order — una orden de onramp/offramp con helpers de alto nivel
 * (instrucciones de depósito normalizadas, QR PIX, polling de estado).
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
 * Busca las instrucciones de depósito en el payload crudo, tolerando los
 * distintos nombres de campo por corredor (SPEI usa `depositClabe`; PIX
 * expone el BR Code "copia e cola").
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
  get id(): string {
    return this.raw.orderId;
  }

  get status(): OrderStatus | undefined {
    return this.raw.status;
  }

  get isOnramp(): boolean {
    return this.raw.orderType === "onramp";
  }

  get isOfframp(): boolean {
    return this.raw.orderType === "offramp";
  }

  /** `true` cuando la orden llegó a un estado final. */
  get isTerminal(): boolean {
    return this.status !== undefined && TERMINAL_ORDER_STATUSES.includes(this.status);
  }

  /** Página de estado con marca de Etherfuse para mostrar al usuario final. */
  get statusPage(): string | undefined {
    return this.raw.statusPage;
  }

  /** Instrucciones de depósito normalizadas (onramps): PIX o SPEI. */
  get deposit(): DepositInstructions | null {
    return extractDeposit(this.raw);
  }

  /**
   * Crea un {@link PixQr} a partir del código PIX de la orden.
   * Devuelve `null` si la orden no tiene instrucciones PIX (p. ej. SPEI/MXN).
   */
  createPixQr(): PixQr | null {
    const code = this.deposit?.pixCode;
    return code ? Pix.fromCode(code, { validate: false }) : null;
  }

  /** Vuelve a leer la orden desde la API y devuelve una instancia fresca. */
  fetch(): Promise<Order> {
    return this.client.orders.fetch(this.id);
  }

  /** Cancela la orden. */
  cancel(): Promise<unknown> {
    return this.client.orders.cancel(this.id);
  }

  /**
   * Hace polling hasta que la orden alcance `status` (o cualquier estado
   * terminal, para no esperar eternamente una orden fallida).
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
          `La orden ${this.id} terminó en "${current.status}" antes de llegar a "${status}".`,
        );
      }
      if (Date.now() >= deadline) {
        throw new EtherfuseError(
          `Timeout esperando que la orden ${this.id} llegue a "${status}" (último estado: "${current.status}").`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      current = await this.fetch();
    }
  }
}

/**
 * Resultado de `client.orders.create(...)`: la API devuelve un resumen
 * (no la orden completa), con las instrucciones de pago.
 */
export class OrderReceipt extends Base<APICreateOrderResult & Record<string, unknown>> {
  readonly orderId: string;
  readonly direction: "onramp" | "offramp" | "unknown";
  /** Onramps: instrucciones de depósito (PIX o SPEI). */
  readonly deposit: DepositInstructions | null;
  /** Offramps Stellar/anchor: datos de retiro. */
  readonly withdraw: WithdrawInstructions | null;

  constructor(client: EtherfuseClient, raw: APICreateOrderResult & Record<string, unknown>) {
    super(client, raw);

    const onramp = (raw.onramp ?? null) as Record<string, unknown> | null;
    const offramp = (raw.offramp ?? null) as Record<string, unknown> | null;
    const flat = raw as Record<string, unknown>;
    const source = onramp ?? offramp ?? flat;

    const id = source["orderId"] ?? flat["orderId"];
    if (typeof id !== "string") {
      throw new EtherfuseError("La respuesta de create order no contiene orderId.");
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

  /** QR PIX del depósito, o `null` si la orden no es PIX. */
  createPixQr(): PixQr | null {
    const code = this.deposit?.pixCode;
    return code ? Pix.fromCode(code, { validate: false }) : null;
  }

  /** Obtiene la orden completa desde la API. */
  fetch(): Promise<Order> {
    return this.client.orders.fetch(this.orderId);
  }
}
