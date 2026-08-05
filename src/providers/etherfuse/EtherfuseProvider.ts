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

/** A syntactically valid throwaway CLABE (18-digit Mexican bank account number): 17 random digits plus the correctly computed check digit (weights 3-7-1, mod 10). Sandbox-only, mirrors the dummy PIX identity below. */
function randomClabe(): string {
  const weights = [3, 7, 1];
  let digits = "";
  for (let i = 0; i < 17; i++) digits += Math.floor(Math.random() * 10);
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (Number(digits[i]) * weights[i % 3]!) % 10;
  const check = (10 - (sum % 10)) % 10;
  return digits + String(check);
}

export interface EtherfuseProviderOptions {
  /** Etherfuse API key. */
  apiKey: string;
  /** `sandbox` (default) or `production` — passed straight to {@link EtherfuseClient}. */
  environment?: EtherfuseClientOptions["environment"];
  /** Provider name used to select it on each `ramp.onramp` call. Default: `"etherfuse"`. */
  name?: string;
  regions?: readonly string[];
  /** Fiat currencies this instance handles. Default: `["BRL"]` (PIX). Etherfuse also settles MXN via SPEI/CLABE — pass `FiatCurrency.MXN` too (or instead) to build those charges. */
  currencies?: readonly string[];
  logoUrl?: string;
  /**
   * Target asset released on completion. Etherfuse only quotes its own
   * stablebonds, not generic stablecoins — `"USDC"` fails with `Non-stable
   * assets are not supported`. Default: the currency's native stablebond —
   * `Asset.TESOURO` for BRL, `Asset.CETES` for MXN — chosen per charge, so
   * a single instance handling both currencies delivers the right bond for
   * each. Set this to pin one specific bond for every charge regardless of
   * currency instead.
   *
   * Pass either a stablebond symbol (resolved automatically, on first use,
   * against `client.lookup.stablebonds()` for `blockchain`) or an already-
   * resolved on-chain token identifier/mint address — `quotes.create`
   * itself only accepts the identifier, not the bare symbol, and this
   * adapter does that lookup for you so `Asset.TESOURO`/`Asset.CETES` "just work".
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

  /** Explicit constructor override, if any — pins one bond for every charge regardless of currency. Unset means "pick per-currency" (see `#targetAssetFor`). */
  #targetAssetOverride?: string;
  #targetAssetIdCache = new Map<string, string>();
  #resolvingTargetAsset = new Map<string, Promise<string>>();
  #blockchain: Chain;
  #publicKey?: string;
  #cryptoWalletId?: string;
  #webhookSecret?: string;
  /** Explicit constructor override, if any — used for every currency regardless of what `#ensureAccount` would've auto-provisioned. */
  #bankAccountId?: string;
  /** Auto-provisioned sandbox accounts, cached per currency (a BRL/PIX account can't receive an MXN deposit, so these can't share one field). */
  #bankAccountIdByCurrency = new Map<string, string>();
  #customerId?: string;
  #provisioning = new Map<string, Promise<{ customerId: string; bankAccountId: string; publicKey?: string; cryptoWalletId?: string }>>();

  constructor(options: EtherfuseProviderOptions) {
    this.name = options.name ?? "etherfuse";
    this.regions = options.regions ?? ["BR"];
    this.currencies = options.currencies ?? [FiatCurrency.BRL];
    this.logoUrl = options.logoUrl;
    this.#targetAssetOverride = options.targetAsset;
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
   * Resolves (once per currency, cached) the customerId, a bank account to
   * deposit `currency` into, and — unless a `cryptoWalletId` is configured
   * — a REGISTERED destination wallet (Etherfuse rejects an inline
   * `publicKey` that isn't already registered: "Wallet not found or not
   * authorized"). The customer and wallet are shared across currencies; the
   * deposit-collection bank account is provisioned separately per currency
   * (a BRL/PIX account can't receive an MXN deposit, and vice versa).
   */
  async #ensureAccount(currency: string): Promise<{ customerId: string; bankAccountId: string; publicKey?: string; cryptoWalletId?: string }> {
    const cachedBankAccountId = this.#bankAccountId ?? this.#bankAccountIdByCurrency.get(currency);
    if (this.#customerId && cachedBankAccountId && (this.#publicKey || this.#cryptoWalletId)) {
      return { customerId: this.#customerId, bankAccountId: cachedBankAccountId, publicKey: this.#publicKey, cryptoWalletId: this.#cryptoWalletId };
    }
    let pending = this.#provisioning.get(currency);
    if (!pending) {
      pending = (async () => {
        const customerId = this.#customerId ?? (await this.client.customers.me()).id;
        this.#customerId = customerId;

        let bankAccountId = this.#bankAccountId ?? this.#bankAccountIdByCurrency.get(currency);
        if (!bankAccountId) {
          // Etherfuse allows only one account per currency per organization —
          // reuse an existing one instead of always trying (and failing) to create a new one.
          const existing = await this.client.bankAccounts.listForCustomer(customerId);
          if (currency === FiatCurrency.MXN) {
            const existingClabe = existing.find((a) => a.isSpei);
            if (existingClabe) {
              bankAccountId = existingClabe.id;
            } else {
              const account = await this.client.bankAccounts.createClabePersonal(customerId, {
                firstName: "Cosmos",
                paternalLastName: "Demo",
                birthDate: "19900101",
                birthCountryIsoCode: "MX",
                curp: "COSD900101HDFXXA01",
                rfc: "COSD900101AB1",
                clabe: randomClabe(),
              });
              bankAccountId = account.id;
            }
          } else {
            const existingPix = existing.find((a) => a.isPix);
            if (existingPix) {
              bankAccountId = existingPix.id;
            } else {
              const account = await this.client.bankAccounts.createPixPersonal(customerId, {
                firstName: "Cosmos",
                lastName: "Demo",
                cpf: "00000000000",
                pixKey: `cosmos-demo-${randomUUID()}@example.com`,
                pixKeyType: "email",
              });
              bankAccountId = account.id;
            }
          }
          this.#bankAccountIdByCurrency.set(currency, bankAccountId);
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

        return { customerId, bankAccountId, publicKey: this.#publicKey, cryptoWalletId: this.#cryptoWalletId };
      })().catch((error: unknown) => {
        // Don't cache a failed attempt — let the next call for this currency retry from scratch.
        this.#provisioning.delete(currency);
        throw error;
      });
      this.#provisioning.set(currency, pending);
    }
    return pending;
  }

  /** The stablebond symbol to quote/deliver for `currency`: the constructor's explicit override if set, else the currency's native bond (CETES for MXN, TESOURO for BRL). */
  #targetAssetFor(currency: string): string {
    return this.#targetAssetOverride ?? (currency === FiatCurrency.MXN ? Asset.CETES : Asset.TESOURO);
  }

  /**
   * `quotes.create` rejects a bare stablebond symbol ("TESOURO") — it wants
   * the on-chain token identifier for `#blockchain`. Resolve it once per
   * symbol (cached) against the public stablebond catalog; if the symbol
   * doesn't match any cataloged entry, assume it's already an identifier.
   */
  async #resolveTargetAsset(currency: string): Promise<string> {
    const symbol = this.#targetAssetFor(currency);
    const cached = this.#targetAssetIdCache.get(symbol);
    if (cached) return cached;
    let pending = this.#resolvingTargetAsset.get(symbol);
    if (!pending) {
      pending = (async () => {
        try {
          const catalog = (await this.client.lookup.stablebonds()) as {
            stablebonds?: Array<{ symbol: string; blockchains?: Array<{ blockchain: string; tokenIdentifier: string }> }>;
          };
          const entry = catalog.stablebonds?.find((b) => b.symbol === symbol);
          const onChain = entry?.blockchains?.find((b) => b.blockchain === this.#blockchain);
          if (onChain) return onChain.tokenIdentifier;
        } catch {
          // Fall through — treat the symbol as already being a resolved identifier.
        }
        return symbol;
      })();
      this.#resolvingTargetAsset.set(symbol, pending);
    }
    const resolved = await pending;
    this.#targetAssetIdCache.set(symbol, resolved);
    return resolved;
  }

  async createCharge(request: CreateChargeRequest): Promise<Charge> {
    const currency = request.currency.toUpperCase();
    if (currency !== FiatCurrency.BRL && currency !== FiatCurrency.MXN) {
      throw new ProviderError(this.name, `EtherfuseProvider only builds PIX (BRL) or SPEI (MXN) charges today, got ${request.currency}.`);
    }
    const [account, targetAsset] = await Promise.all([this.#ensureAccount(currency), this.#resolveTargetAsset(currency)]);
    const quote = await this.client.quotes.create({
      customerId: account.customerId,
      blockchain: this.#blockchain,
      sourceAmount: request.amount.toFixed(2),
      quoteAssets: { type: "onramp", sourceAsset: currency, targetAsset },
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
