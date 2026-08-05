/**
 * EtherfuseProvider — wraps {@link EtherfuseClient} as a `PaymentProvider`
 * for {@link CosmosRamp}.
 *
 * Etherfuse is a complete onramp rail on its own: it collects the PIX
 * deposit AND releases the crypto internally. This adapter only surfaces
 * its fiat leg through the `PaymentProvider` contract, so it shows up in a
 * provider picker next to Mercado Pago/Custom providers with no
 * special-casing. Because Etherfuse already handles its own crypto release,
 * don't ALSO run a `CosmosRamp` `settlement` adapter for its orders if you
 * share one `CosmosRamp` instance with a rail that needs one (check
 * `order.provider` inside your settlement function and skip it for this
 * provider's name).
 *
 * Unlike Mercado Pago, the order API never returns a raw PIX "copia e cola"
 * string to render your own QR from — it returns a `statusPage` URL, a page
 * Etherfuse hosts itself (the actual QR renders there). So every charge
 * this adapter builds is `method: "link"`, never `"qr"` — a `<QRCode>`
 * pointed at a PIX EMV string would have nothing to encode.
 *
 * Creating an order requires a `bankAccountId` and a registered destination
 * wallet. This adapter auto-provisions a sandbox PIX account and, for
 * `blockchain: Chain.Solana`, a throwaway registered wallet on first use
 * (both cached after that) so `createCharge` works out of the box against
 * `environment: "sandbox"`; pass `bankAccountId`/`publicKey`/`cryptoWalletId`
 * yourself for production.
 */

import { generateKeyPairSync } from "node:crypto";
import { randomUUID } from "@/atoms/constants";
import { Asset, Chain, FiatCurrency } from "@/atoms/enums";
import { ProviderError } from "@/core/errors";
import { hmacSha256Hex, timingSafeEqualStr } from "@/core/signature";
import { EtherfuseClient, type EtherfuseClientOptions } from "@/client/EtherfuseClient";
import type {
  Charge,
  ChargeState,
  ChargeStatus,
  CreateChargeRequest,
  PaymentProvider,
  WebhookNotification,
  WebhookRequest,
} from "@/core/types";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) + BigInt(b);
  let encoded = "";
  while (num > 0n) {
    encoded = BASE58_ALPHABET[Number(num % 58n)] + encoded;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded || "1";
}

/** A fresh, throwaway Solana-format address (a raw ed25519 public key, base58-encoded) — nobody holds the matching private key. */
function randomSolanaAddress(): string {
  const { publicKey } = generateKeyPairSync("ed25519", { publicKeyEncoding: { format: "jwk" } });
  const x = (publicKey as unknown as { x: string }).x;
  return base58Encode(Buffer.from(x, "base64url"));
}

export interface EtherfuseProviderOptions {
  /** Etherfuse API key. */
  apiKey: string;
  /** `sandbox` (default) or `production` — passed straight to {@link EtherfuseClient}. */
  environment?: EtherfuseClientOptions["environment"];
  /** Provider name used to select it on each `ramp.onramp` call. Default: `"etherfuse"`. */
  name?: string;
  regions?: readonly string[];
  /** Fiat currencies this instance handles. Default: `["BRL"]` (PIX). Etherfuse also settles MXN (SPEI) — this adapter only builds PIX charges today. */
  currencies?: readonly string[];
  logoUrl?: string;
  /**
   * Target asset released on completion. Etherfuse only quotes its own
   * stablebonds, not generic stablecoins — `"USDC"` fails with `Non-stable
   * assets are not supported`. Default: `Asset.TESOURO` (BRL-denominated).
   *
   * Pass either a stablebond symbol (resolved automatically, on first use,
   * against `client.lookup.stablebonds()` for `blockchain`) or an already-
   * resolved on-chain token identifier/mint address — `quotes.create`
   * itself only accepts the identifier, not the bare symbol, and this
   * adapter does that lookup for you so `Asset.TESOURO` "just works".
   */
  targetAsset?: string;
  /** Blockchain the crypto leg settles on. Default: `Chain.Solana`. */
  blockchain?: Chain;
  /**
   * Destination address for the released crypto. Etherfuse requires one of
   * `publicKey`/`cryptoWalletId` per order — this isn't part of
   * `CreateChargeRequest` (that's CosmosRamp's Stellar-oriented `wallet`,
   * used only by your own settlement adapter, never seen by providers), so
   * set it here, or per-call via `providerOptions.publicKey`. Omit both and,
   * for `blockchain: Chain.Solana` only, a fresh throwaway address is
   * generated per charge — fine for a sandbox demo, not for anything you
   * intend to actually withdraw.
   */
  publicKey?: string;
  /** An Etherfuse-registered wallet id — alternative to `publicKey`. */
  cryptoWalletId?: string;
  /** Existing bank account to deposit into — skips auto-provisioning a sandbox one. */
  bankAccountId?: string;
  /** Etherfuse customerId — skips the `GET /ramp/me` lookup. */
  customerId?: string;
  /** HMAC secret for verifying Etherfuse webhooks, if you register one (`client.webhooks.create`). */
  webhookSecret?: string;
  fetch?: typeof fetch;
}

function mapOrderStatus(status: string | undefined): ChargeStatus {
  switch (status) {
    case "completed":
    case "finalized":
      return "approved";
    case "failed":
      return "rejected";
    case "refunded":
      return "refunded";
    case "canceled":
      return "canceled";
    // "created" and "funded" are both still in flight from the fiat side.
    default:
      return "pending";
  }
}

export class EtherfuseProvider implements PaymentProvider {
  readonly name: string;
  readonly regions: readonly string[];
  readonly currencies: readonly string[];
  readonly logoUrl?: string;

  /** Underlying client — escape hatch for anything this adapter doesn't surface (e.g. `client.sandbox.fiatReceived`). */
  readonly client: EtherfuseClient;

  #targetAsset: string;
  #targetAssetId?: string;
  #resolvingTargetAsset?: Promise<string>;
  #blockchain: Chain;
  #publicKey?: string;
  #cryptoWalletId?: string;
  #webhookSecret?: string;
  #bankAccountId?: string;
  #customerId?: string;
  #provisioning?: Promise<{ customerId: string; bankAccountId: string }>;

  constructor(options: EtherfuseProviderOptions) {
    this.name = options.name ?? "etherfuse";
    this.regions = options.regions ?? ["BR"];
    this.currencies = options.currencies ?? [FiatCurrency.BRL];
    this.logoUrl = options.logoUrl;
    this.#targetAsset = options.targetAsset ?? Asset.TESOURO;
    this.#blockchain = options.blockchain ?? Chain.Solana;
    this.#publicKey = options.publicKey;
    this.#cryptoWalletId = options.cryptoWalletId;
    this.#webhookSecret = options.webhookSecret;
    this.#bankAccountId = options.bankAccountId;
    this.#customerId = options.customerId;
    this.client = new EtherfuseClient({
      apiKey: options.apiKey,
      environment: options.environment,
      fetch: options.fetch,
    });
  }

  /**
   * Resolves (once, cached) the customerId, a bank account to deposit into,
   * and — unless a `cryptoWalletId` is configured — a REGISTERED destination
   * wallet (Etherfuse rejects an inline `publicKey` that isn't already
   * registered: "Wallet not found or not authorized").
   */
  async #ensureAccount(): Promise<{ customerId: string; bankAccountId: string; publicKey?: string; cryptoWalletId?: string }> {
    if (this.#customerId && this.#bankAccountId && (this.#publicKey || this.#cryptoWalletId)) {
      return { customerId: this.#customerId, bankAccountId: this.#bankAccountId, publicKey: this.#publicKey, cryptoWalletId: this.#cryptoWalletId };
    }
    if (!this.#provisioning) {
      this.#provisioning = (async () => {
        const customerId = this.#customerId ?? (await this.client.customers.me()).id;
        this.#customerId = customerId;

        if (!this.#bankAccountId) {
          // Etherfuse allows only one BRL account per organization — reuse
          // an existing one instead of always trying (and failing) to create a new one.
          const existing = await this.client.bankAccounts.listForCustomer(customerId);
          const existingPix = existing.find((a) => a.isPix);
          if (existingPix) {
            this.#bankAccountId = existingPix.id;
          } else {
            const account = await this.client.bankAccounts.createPixPersonal(customerId, {
              firstName: "Cosmos",
              lastName: "Demo",
              cpf: "00000000000",
              pixKey: `cosmos-demo-${randomUUID()}@example.com`,
              pixKeyType: "email",
            });
            this.#bankAccountId = account.id;
          }
        }

        if (!this.#publicKey && !this.#cryptoWalletId) {
          if (this.#blockchain !== Chain.Solana) {
            throw new ProviderError(
              this.name,
              `No destination wallet: pass \`publicKey\` or \`cryptoWalletId\` for blockchain "${this.#blockchain}".`,
            );
          }
          // Reuse an already-registered wallet on this chain if there is one, else register a fresh throwaway address.
          const existingWallets = await this.client.wallets.listForCustomer(customerId);
          const existingWallet = existingWallets.find((w) => w.blockchain === this.#blockchain);
          if (existingWallet?.publicKey) {
            this.#publicKey = existingWallet.publicKey;
          } else {
            const wallet = await this.client.wallets.registerForCustomer(customerId, {
              publicKey: randomSolanaAddress(),
              blockchain: this.#blockchain,
            });
            this.#publicKey = wallet.publicKey;
          }
        }

        return { customerId, bankAccountId: this.#bankAccountId, publicKey: this.#publicKey, cryptoWalletId: this.#cryptoWalletId };
      })().catch((error: unknown) => {
        // Don't cache a failed attempt — let the next call retry from scratch.
        this.#provisioning = undefined;
        throw error;
      });
    }
    return this.#provisioning;
  }

  /**
   * `quotes.create` rejects a bare stablebond symbol ("TESOURO") — it wants
   * the on-chain token identifier for `#blockchain`. Resolve it once
   * (cached) against the public stablebond catalog; if `#targetAsset`
   * doesn't match any cataloged symbol, assume it's already an identifier.
   */
  async #resolveTargetAsset(): Promise<string> {
    if (this.#targetAssetId) return this.#targetAssetId;
    if (!this.#resolvingTargetAsset) {
      this.#resolvingTargetAsset = (async () => {
        try {
          const catalog = (await this.client.lookup.stablebonds()) as {
            stablebonds?: Array<{ symbol: string; blockchains?: Array<{ blockchain: string; tokenIdentifier: string }> }>;
          };
          const entry = catalog.stablebonds?.find((b) => b.symbol === this.#targetAsset);
          const onChain = entry?.blockchains?.find((b) => b.blockchain === this.#blockchain);
          if (onChain) return onChain.tokenIdentifier;
        } catch {
          // Fall through — treat targetAsset as already being a resolved identifier.
        }
        return this.#targetAsset;
      })();
    }
    this.#targetAssetId = await this.#resolvingTargetAsset;
    return this.#targetAssetId;
  }

  async createCharge(request: CreateChargeRequest): Promise<Charge> {
    if (request.currency.toUpperCase() !== FiatCurrency.BRL) {
      throw new ProviderError(this.name, `EtherfuseProvider only builds PIX (BRL) charges today, got ${request.currency}.`);
    }
    const [account, targetAsset] = await Promise.all([this.#ensureAccount(), this.#resolveTargetAsset()]);
    const quote = await this.client.quotes.create({
      customerId: account.customerId,
      blockchain: this.#blockchain,
      sourceAmount: request.amount.toFixed(2),
      quoteAssets: { type: "onramp", sourceAsset: request.currency.toUpperCase(), targetAsset },
    });

    const cryptoWalletId = (request.providerOptions?.cryptoWalletId as string | undefined) ?? account.cryptoWalletId;
    const publicKey = (request.providerOptions?.publicKey as string | undefined) ?? account.publicKey;
    const receipt = await quote.createOrder({ bankAccountId: account.bankAccountId, publicKey, cryptoWalletId });
    // The creation response never carries a statusPage — read the order back to get it.
    const order = await this.client.orders.fetch(receipt.orderId);
    if (!order.statusPage) {
      throw new ProviderError(this.name, "Etherfuse didn't return a status page link for this order.");
    }
    return {
      id: receipt.orderId,
      method: "link",
      link: order.statusPage,
      raw: order.raw,
    };
  }

  async getCharge(chargeId: string): Promise<ChargeState> {
    const order = await this.client.orders.fetch(chargeId);
    return {
      id: order.id,
      status: mapOrderStatus(order.status),
      amount: Number(order.raw.amountInFiat ?? 0),
      currency: order.raw.sourceAsset ?? FiatCurrency.BRL,
      raw: order.raw,
    };
  }

  /**
   * Etherfuse's webhook signature header isn't documented publicly at the
   * time of writing — this checks `x-etherfuse-signature` against an HMAC of
   * the raw body, mirroring `MercadoPagoProvider`'s pattern. Verify against
   * your registered webhook once you have a real payload and adjust the
   * header name here if needed. Without a `webhookSecret` configured, this
   * trusts the payload (same behavior as providers with no signature).
   */
  async verifyWebhook(request: WebhookRequest): Promise<boolean> {
    if (!this.#webhookSecret) return true;
    const signature = request.headers["x-etherfuse-signature"] ?? request.headers["X-Etherfuse-Signature"];
    if (!signature || Array.isArray(signature)) return false;
    const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const expected = await hmacSha256Hex(this.#webhookSecret, body);
    return timingSafeEqualStr(expected, signature);
  }

  async parseWebhook(request: WebhookRequest): Promise<WebhookNotification | null> {
    const body = (typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body) as Record<string, unknown>;
    const orderId = body.orderId ?? body.order_id;
    if (typeof orderId !== "string") return null;
    return { chargeId: orderId, kind: typeof body.type === "string" ? body.type : "order_updated", raw: body };
  }
}
