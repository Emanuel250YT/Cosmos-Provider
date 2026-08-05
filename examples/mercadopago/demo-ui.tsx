/**
 * Local demo: a small "Cosmos" wizard that shows off the SDK's operations —
 * Buy USDC, Sell USDC, Get a quote — picked from a round button in the
 * bottom-right corner. Each operation walks through a few steps (provider →
 * currency → [method] → amount) built from `cosmos-providers/react`'s real
 * components (`PaymentMethodCard`, `PaymentOptionRow`, `ReceivePayment`,
 * `PaymentConfirmation`, `SummaryRow`), server-rendered with
 * `react-dom/server` and fed by the `cosmos-providers/react/server` mappers.
 * Steps animate in/out; the language switch (top-right, flags) and the
 * light/dark toggle next to it re-render the wizard's own copy.
 *
 *   npm run demo:ui     (or: npx tsx examples/mercadopago/demo-ui.tsx)
 *   → open http://localhost:4000
 *
 * Three providers are registered by default — `EtherfuseProvider`,
 * `MercadoPagoProvider` (BR) and `MercadoPagoProvider` (AR), each with a
 * `logoUrl` — reusing `ramp.providers` for the picker means adding a fourth
 * is the only change needed anywhere.
 *
 * Live vs. Simulated (top-left pill): Simulated runs against the Mercado
 * Pago simulator (`examples/helpers/mock-mercadopago`) — safe, deterministic,
 * no external calls. Live uses your real `.env` credentials:
 * - Etherfuse: `ETHERFUSE_API_KEY` is a sandbox key, so Live Etherfuse always
 *   hits Etherfuse's real sandbox — safe either way, no mode-gating needed.
 * - Mercado Pago: Live uses `MP_BR_ACCESS_TOKEN`/`MP_AR_ACCESS_TOKEN`
 *   directly. If `MP_BR_ACCESS_TOKEN` is a PRODUCTION credential (starts
 *   with `APP_USR-`, not `TEST-`), Live Mercado Pago charges are REAL —
 *   scanning/opening one moves real money. `mercadopago-ar` only appears in
 *   Live mode if `MP_AR_ACCESS_TOKEN` is actually set.
 * Because a local dev server can't receive real inbound webhooks, "confirm"
 * in Live mode polls the provider's real charge status instead of
 * simulating a webhook — it only completes once someone has genuinely paid.
 *
 * Two things are deliberately real even in Simulated mode — see
 * examples/mercadopago/settlement-demo.ts for the full rationale:
 * - The rate: `CoinGeckoOracle`, no fixed/mocked number.
 * - The release: a REAL Stellar testnet transaction for a proper asset,
 *   EXCEPT for Etherfuse orders, which release their own crypto internally
 *   (this demo skips its own settlement for those — see `settlementFn`).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset as StellarAsset, BASE_FEE } from "@stellar/stellar-sdk";
import {
  CosmosRamp,
  MercadoPagoProvider,
  EtherfuseProvider,
  CoinGeckoOracle,
  FiatCurrency,
  type RampOrderData,
  type QuoteBreakdown,
  type PaymentProvider,
  type SettlementFn,
} from "../../src/index";
import { ReceivePayment, PaymentConfirmation, PaymentMethodCard, PaymentOptionRow, SummaryRow } from "../../src/react";
import { chargeToQrProps, rampOrderToDetailRows, quoteToSummaryRows } from "../../src/react/server";
import { createMockMercadoPago } from "../helpers/mock-mercadopago";
import { randomAmount } from "../helpers/random";

const PORT = 4000;
const WEBHOOK_SECRET = "demo-mp-secret";

type Op = "buy" | "sell" | "quote";
type Method = "qr" | "link";
type Currency = "ARS" | "BRL";
type Lang = "en" | "es" | "pt";
type Mode = "simulated" | "live";
interface WizardState {
  provider: string;
  currency: Currency | null;
  method: Method | null;
  amount: number | null;
}

/** Test-amount bounds for this demo. Fiat: BRL for PIX QR, ARS for the link. Crypto: the "sell" flow. */
const BRL_TEST_RANGE = [5, 30] as const;
const ARS_TEST_RANGE = [1500, 5000] as const;
const CRYPTO_TEST_RANGE = [10, 100] as const;

const STEPS: Record<Op, string[]> = {
  buy: ["provider", "currency", "method", "amount"],
  sell: ["provider", "currency", "amount"],
  quote: ["provider", "currency", "amount"],
};

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    opBuy: "Buy USDC",
    opSell: "Sell USDC",
    opQuote: "Get a quote",
    stepProvider: "Provider",
    stepCurrency: "Currency",
    stepMethod: "Method",
    stepAmount: "Amount",
    subtitleBuy: "Choose a provider and how you'd like to pay.",
    subtitleSell: "Choose a provider and how much USDC you're selling.",
    subtitleQuote: "Get a live quote from a provider.",
    continueLabel: "Continue",
    getQuoteLabel: "Get quote",
    back: "‹ Back",
    ars: "Argentine Pesos (ARS)",
    brl: "Brazilian Real (BRL)",
    pix: "PIX QR",
    link: "Payment link",
    amountFiat: "Amount",
    amountCrypto: "Amount (USDC)",
    ivePaid: "I've paid",
    iveSent: "I've sent the USDC",
    checkStatus: "Check status",
    simulatePaymentSandbox: "Simulate payment (Etherfuse sandbox)",
    stillPending: "Still pending — try again in a moment.",
    startOver: "Start over",
    waitingPayment: "Waiting for payment",
    waitingCrypto: "Waiting for your USDC",
    step: "Step",
    of: "of",
    chooseOperation: "Choose an operation",
    liveLabel: "Live",
    simulatedLabel: "Simulated",
    lightLabel: "Light",
    darkLabel: "Dark",
  },
  es: {
    opBuy: "Comprar USDC",
    opSell: "Vender USDC",
    opQuote: "Obtener cotización",
    stepProvider: "Proveedor",
    stepCurrency: "Divisa",
    stepMethod: "Método",
    stepAmount: "Monto",
    subtitleBuy: "Elegí un proveedor y cómo querés pagar.",
    subtitleSell: "Elegí un proveedor y cuánto USDC querés vender.",
    subtitleQuote: "Obtené una cotización en vivo de un proveedor.",
    continueLabel: "Continuar",
    getQuoteLabel: "Obtener cotización",
    back: "‹ Atrás",
    ars: "Pesos Argentinos (ARS)",
    brl: "Real Brasileño (BRL)",
    pix: "QR PIX",
    link: "Link de pago",
    amountFiat: "Monto",
    amountCrypto: "Monto (USDC)",
    ivePaid: "Ya pagué",
    iveSent: "Ya envié el USDC",
    checkStatus: "Verificar estado",
    simulatePaymentSandbox: "Simular pago (sandbox de Etherfuse)",
    stillPending: "Todavía pendiente — probá de nuevo en un momento.",
    startOver: "Empezar de nuevo",
    waitingPayment: "Esperando el pago",
    waitingCrypto: "Esperando tu USDC",
    step: "Paso",
    of: "de",
    chooseOperation: "Elegí una operación",
    liveLabel: "Real",
    simulatedLabel: "Simulado",
    lightLabel: "Claro",
    darkLabel: "Nocturno",
  },
  pt: {
    opBuy: "Comprar USDC",
    opSell: "Vender USDC",
    opQuote: "Obter cotação",
    stepProvider: "Provedor",
    stepCurrency: "Moeda",
    stepMethod: "Método",
    stepAmount: "Valor",
    subtitleBuy: "Escolha um provedor e como você quer pagar.",
    subtitleSell: "Escolha um provedor e quanto USDC você está vendendo.",
    subtitleQuote: "Obtenha uma cotação em tempo real de um provedor.",
    continueLabel: "Continuar",
    getQuoteLabel: "Obter cotação",
    back: "‹ Voltar",
    ars: "Pesos Argentinos (ARS)",
    brl: "Real Brasileiro (BRL)",
    pix: "QR PIX",
    link: "Link de pagamento",
    amountFiat: "Valor",
    amountCrypto: "Valor (USDC)",
    ivePaid: "Já paguei",
    iveSent: "Já enviei o USDC",
    checkStatus: "Verificar status",
    simulatePaymentSandbox: "Simular pagamento (sandbox da Etherfuse)",
    stillPending: "Ainda pendente — tente novamente em instantes.",
    startOver: "Começar de novo",
    waitingPayment: "Aguardando pagamento",
    waitingCrypto: "Aguardando seu USDC",
    step: "Etapa",
    of: "de",
    chooseOperation: "Escolha uma operação",
    liveLabel: "Real",
    simulatedLabel: "Simulado",
    lightLabel: "Claro",
    darkLabel: "Escuro",
  },
};
const t = (lang: Lang, key: string): string => STRINGS[lang]?.[key] ?? key;

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const providerLabel = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, " ");
const initials = (name: string): string => name.slice(0, 2).toUpperCase();
const methodsForProvider = (providerName: string, currency: Currency): Method[] => {
  // Etherfuse never returns a raw PIX code to render our own QR from — it's
  // always a hosted status-page link (see EtherfuseProvider's docstring).
  if (providerName.startsWith("etherfuse")) return ["link"];
  return currency === "BRL" ? ["qr", "link"] : ["link"];
};

// ---------------------------------------------------------------------------
// Static assets: flag-icons (npm) for the language switch, plus this demo's
// own default provider logos.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLAGS_DIR = path.join(path.dirname(require.resolve("flag-icons/package.json")), "flags", "4x3");
const LOGOS_DIR = path.join(HERE, "assets", "images");
const LANG_FLAG: Record<Lang, string> = { en: "us", es: "es", pt: "br" };

// ---------------------------------------------------------------------------
// Providers, oracle, settlement — Simulated and Live variants.
// ---------------------------------------------------------------------------

const stellarServer = new Horizon.Server("https://horizon-testnet.stellar.org");
const mp = createMockMercadoPago({ webhookSecret: WEBHOOK_SECRET });

console.log("Funding a Stellar testnet demo-USDC issuer (Friendbot)...");
// Doubles as the "treasury": the account that issues an asset can send it
// directly, with no trustline of its own — issuing IS just a payment.
const issuer = Keypair.random();
// Populated by demoWallet() below — settlement needs each receiving
// wallet's own keypair to sign the trustline it opens for itself.
const walletByAddress = new Map<string, Keypair>();
let stellarReady = false;
try {
  await stellarServer.friendbot(issuer.publicKey()).call();
  stellarReady = true;
  console.log(`✔ Demo USDC issuer funded: ${issuer.publicKey()}`);
} catch (error) {
  console.warn("⚠ Could not reach Stellar testnet/Friendbot — settlement will fall back to a simulated tx id:", error);
}

/** A fresh, Friendbot-funded Stellar address to receive the settlement. */
async function demoWallet(): Promise<string> {
  const kp = Keypair.random();
  if (stellarReady) {
    try {
      await stellarServer.friendbot(kp.publicKey()).call();
      walletByAddress.set(kp.publicKey(), kp);
    } catch {
      // Ignore — settlement just falls back to a simulated tx id for this wallet.
    }
  }
  return kp.publicKey();
}

/**
 * Shared by both CosmosRamp instances AND called directly for Live/Etherfuse
 * confirmations (see confirmOrder below) — Etherfuse orders skip this
 * entirely (it already released its own crypto); everything else gets a
 * real Stellar testnet release, regardless of whether the fiat leg was
 * simulated or live.
 */
const settlementFn: SettlementFn = async ({ order, wallet, amount, asset }) => {
  if (order.provider.startsWith("etherfuse")) {
    console.log(`⛓ ${order.provider}: crypto already released internally by Etherfuse — skipping this demo's settlement.`);
    return { txId: `etherfuse-managed:${order.id}` };
  }
  const receiver = wallet ? walletByAddress.get(wallet) : undefined;
  if (stellarReady && wallet && receiver) {
    try {
      // Real Stellar asset (code = whatever `asset` the order actually
      // requested — "USDC" by default), issued by the demo issuer above.
      // The receiving wallet's trustline is opened and the payment sent
      // in the SAME transaction: `changeTrust` sourced from the wallet,
      // `payment` sourced from the issuer, signed by both.
      const stellarAsset = new StellarAsset(asset, issuer.publicKey());
      const account = await stellarServer.loadAccount(issuer.publicKey());
      const tx = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 2), networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.changeTrust({ asset: stellarAsset, source: wallet }))
        .addOperation(
          Operation.payment({
            destination: wallet,
            asset: stellarAsset,
            amount: String(Math.round(amount * 1e7) / 1e7),
          }),
        )
        .setTimeout(30)
        .build();
      tx.sign(issuer);
      tx.sign(receiver);
      const result = await stellarServer.submitTransaction(tx);
      console.log(`⛓ settlement: opened trustline + sent ${amount} ${asset} (testnet, real asset) → ${wallet} — https://stellar.expert/explorer/testnet/tx/${result.hash}`);
      return { txId: result.hash };
    } catch (error) {
      console.warn(`⚠ Stellar settlement failed, falling back to a simulated tx id: ${String(error)}`);
    }
  }
  console.log(`⛓ settlement (simulated): sent ${amount} ${asset} → ${wallet}`);
  return { txId: `0xdemo${Date.now()}` };
};

const etherfuseProvider = new EtherfuseProvider({
  apiKey: process.env.ETHERFUSE_API_KEY ?? "",
  environment: "sandbox",
  logoUrl: "/assets/logo/etherfuse.svg",
});

const oracle = () => new CoinGeckoOracle({ apiKey: process.env.COINGECKO_API_KEY });

const rampSimulated = new CosmosRamp({
  providers: [
    etherfuseProvider,
    new MercadoPagoProvider({
      name: "mercadopago-br",
      regions: ["BR"],
      currencies: [FiatCurrency.BRL],
      accessToken: "TEST-demo-br",
      webhookSecret: WEBHOOK_SECRET,
      defaultPayerEmail: "buyer@example.com",
      fetch: mp.fetchImpl,
      logoUrl: "/assets/logo/mercadopago-br.svg",
    }),
    new MercadoPagoProvider({
      name: "mercadopago-ar",
      regions: ["AR"],
      currencies: [FiatCurrency.ARS],
      accessToken: "TEST-demo-ar",
      webhookSecret: WEBHOOK_SECRET,
      defaultPayerEmail: "buyer@example.com",
      fetch: mp.fetchImpl,
      logoUrl: "/assets/logo/mercadopago-ar.svg",
    }),
  ],
  oracle: oracle(),
  settlement: settlementFn,
});

const liveProviders: PaymentProvider[] = [etherfuseProvider];
if (process.env.MP_BR_ACCESS_TOKEN) {
  liveProviders.push(
    new MercadoPagoProvider({
      name: "mercadopago-br",
      regions: ["BR"],
      currencies: [FiatCurrency.BRL],
      accessToken: process.env.MP_BR_ACCESS_TOKEN,
      webhookSecret: process.env.MP_BR_WEBHOOK_SECRET,
      defaultPayerEmail: "buyer@example.com",
      logoUrl: "/assets/logo/mercadopago-br.svg",
    }),
  );
}
if (process.env.MP_AR_ACCESS_TOKEN) {
  liveProviders.push(
    new MercadoPagoProvider({
      name: "mercadopago-ar",
      regions: ["AR"],
      currencies: [FiatCurrency.ARS],
      accessToken: process.env.MP_AR_ACCESS_TOKEN,
      webhookSecret: process.env.MP_AR_WEBHOOK_SECRET,
      defaultPayerEmail: "buyer@example.com",
      logoUrl: "/assets/logo/mercadopago-ar.svg",
    }),
  );
}
const rampLive = new CosmosRamp({ providers: liveProviders, oracle: oracle(), settlement: settlementFn });

function rampFor(mode: Mode): CosmosRamp {
  return mode === "live" ? rampLive : rampSimulated;
}

console.log(`Simulated providers: ${rampSimulated.providers.map((p) => p.name).join(", ")}`);
console.log(`Live providers: ${rampLive.providers.map((p) => p.name).join(", ")}${process.env.MP_BR_ACCESS_TOKEN ? " — mercadopago-br is LIVE (real API)" : ""}`);

// ---------------------------------------------------------------------------
// Wizard steps — provider → currency → [method] → amount.
// ---------------------------------------------------------------------------

function providersFor(op: Op, mode: Mode): readonly PaymentProvider[] {
  const all = rampFor(mode).providers;
  // Etherfuse doesn't support payouts in this adapter — leave it out of "sell".
  return op === "sell" ? all.filter((p) => !p.name.startsWith("etherfuse")) : all;
}

function wizardShell(op: Op, lang: Lang, stepName: string, bodyHtml: string): string {
  const steps = STEPS[op];
  const idx = Math.max(0, steps.indexOf(stepName));
  const backBtn = idx > 0 ? `<button class="back" onclick="goBack()">${t(lang, "back")}</button>` : "<span></span>";
  const dots = steps.map((_, i) => `<span class="dot${i === idx ? " active" : ""}"></span>`).join("");
  const opTitleKey = op === "buy" ? "opBuy" : op === "sell" ? "opSell" : "opQuote";
  const subtitleKey = op === "buy" ? "subtitleBuy" : op === "sell" ? "subtitleSell" : "subtitleQuote";
  const stepLabelKey = stepName === "provider" ? "stepProvider" : stepName === "currency" ? "stepCurrency" : stepName === "method" ? "stepMethod" : "stepAmount";
  return `<div style="width:100%;max-width:420px;box-sizing:border-box;margin:0 auto;background:#fff;border-radius:24px;padding:24px;font-family:Helvetica, Arial, sans-serif;color:#111827">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      ${backBtn}
      <span style="font-size:11px;color:#9CA3AF">${t(lang, "step")} ${idx + 1} ${t(lang, "of")} ${steps.length}</span>
    </div>
    <div style="display:flex;gap:4px;justify-content:center;margin-bottom:16px">${dots}</div>
    <h1 style="font-size:20px;margin:0 0 4px;text-align:center">${t(lang, opTitleKey)}</h1>
    <p style="color:#6B7280;margin:0 0 20px;font-size:13px;text-align:center">${t(lang, subtitleKey)}</p>
    <div style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">${t(lang, stepLabelKey)}</div>
    ${bodyHtml}
  </div>`;
}

function renderProviderBody(op: Op, mode: Mode, state: WizardState): string {
  const rows = providersFor(op, mode)
    .map((p) => {
      const card = renderToStaticMarkup(
        <PaymentMethodCard
          iconLabel={initials(p.name)}
          iconBg="#111827"
          logoUrl={p.logoUrl}
          title={providerLabel(p.name)}
          subtitle={p.currencies.length ? p.currencies.join(" · ") : p.regions.join(" · ")}
          selected={p.name === state.provider}
          radioColor={p.name === state.provider ? "#111827" : "#D1D5DB"}
        />,
      );
      return `<div class="pickable" onclick="selectStep('provider','${p.name}')">${card}</div>`;
    })
    .join("");
  return `<div style="display:flex;flex-direction:column;gap:8px">${rows}</div>`;
}

function renderCurrencyBody(state: WizardState, lang: Lang): string {
  const rows = (["ARS", "BRL"] as const)
    .map((c) => {
      const row = renderToStaticMarkup(
        <PaymentOptionRow label={t(lang, c === "ARS" ? "ars" : "brl")} selected={c === state.currency} radioColor={c === state.currency ? "#4F46E5" : "#D1D5DB"} />,
      );
      return `<div class="pickable" onclick="selectStep('currency','${c}')">${row}</div>`;
    })
    .join("");
  return `<div style="display:flex;flex-direction:column;gap:8px">${rows}</div>`;
}

function renderMethodBody(state: WizardState, lang: Lang): string {
  const methods = methodsForProvider(state.provider, state.currency ?? "ARS");
  const rows = methods
    .map((m) => {
      const row = renderToStaticMarkup(
        <PaymentOptionRow label={t(lang, m === "qr" ? "pix" : "link")} selected={m === state.method} radioColor={m === state.method ? "#4F46E5" : "#D1D5DB"} />,
      );
      return `<div class="pickable" onclick="selectStep('method','${m}')">${row}</div>`;
    })
    .join("");
  return `<div style="display:flex;flex-direction:column;gap:8px">${rows}</div>`;
}

function renderAmountBody(op: Op, state: WizardState, lang: Lang): string {
  const fieldStyle = "width:100%;box-sizing:border-box;border:1px solid #E5E7EB;border-radius:10px;padding:12px 14px;font-size:14px;margin-bottom:20px";
  const buttonStyle = "width:100%;background:#111827;color:#fff;border:none;border-radius:16px;padding:16px;font-size:16px;font-weight:700;cursor:pointer";

  if (op === "sell") {
    const [min, max] = CRYPTO_TEST_RANGE;
    const value = clamp(state.amount ?? randomAmount(min, max), min, max);
    return `<label style="display:block;font-size:12px;color:#6B7280;font-weight:600;margin-bottom:6px">${t(lang, "amountCrypto")} (${min}–${max})</label>
      <input id="amountInput" type="number" min="${min}" max="${max}" step="0.01" value="${value}" style="${fieldStyle}" />
      <button onclick="submitStep()" style="${buttonStyle}">${t(lang, "continueLabel")}</button>`;
  }

  const currency = state.currency ?? "ARS";
  const range = currency === "BRL" ? BRL_TEST_RANGE : ARS_TEST_RANGE;
  const value = clamp(state.amount ?? randomAmount(range[0], range[1]), range[0], range[1]);
  const label = op === "quote" ? t(lang, "getQuoteLabel") : t(lang, "continueLabel");
  return `<label style="display:block;font-size:12px;color:#6B7280;font-weight:600;margin-bottom:6px">${t(lang, "amountFiat")} (${currency}, ${range[0]}–${range[1]})</label>
    <input id="amountInput" type="number" min="${range[0]}" max="${range[1]}" step="0.01" value="${value}" style="${fieldStyle}" />
    <button onclick="submitStep()" style="${buttonStyle}">${label}</button>`;
}

function renderStep(op: Op, stepName: string, state: WizardState, lang: Lang, mode: Mode): string {
  const body =
    stepName === "provider"
      ? renderProviderBody(op, mode, state)
      : stepName === "currency"
        ? renderCurrencyBody(state, lang)
        : stepName === "method"
          ? renderMethodBody(state, lang)
          : renderAmountBody(op, state, lang);
  return wizardShell(op, lang, stepName, body);
}

// ---------------------------------------------------------------------------
// Result views — all built from cosmos-providers/react's actual components.
// ---------------------------------------------------------------------------

/** The real QR/payment-link view a buyer would see. */
async function renderPending(order: RampOrderData, lang: Lang): Promise<string> {
  const qr = await chargeToQrProps(order.charge, { width: 240 });
  return renderToStaticMarkup(
    <ReceivePayment
      amount={`${order.quote.fiatAmount.toFixed(2)} ${order.quote.currency}`}
      statusLabel={t(lang, "waitingPayment")}
      statusColor="#9CA3AF"
      qr={qr ?? undefined}
      paymentLink={!qr ? order.charge?.link : undefined}
      rows={rampOrderToDetailRows(order)}
    />,
  );
}

/** The status card shown while waiting for the seller's crypto to arrive (no QR — offramp has no charge). */
function renderSellPending(order: RampOrderData, lang: Lang): string {
  return renderToStaticMarkup(
    <ReceivePayment
      title={t(lang, "waitingCrypto")}
      amount={`${order.quote.cryptoAmount} ${order.quote.asset}`}
      statusLabel={t(lang, "waitingCrypto")}
      statusColor="#9CA3AF"
      rows={rampOrderToDetailRows(order)}
    />,
  );
}

/** The receipt shown once an order is paid and settled. */
function renderReceipt(order: RampOrderData): string {
  return renderToStaticMarkup(
    <PaymentConfirmation
      itemTitle={`${order.direction === "onramp" ? "Buy" : "Sell"} USDC · ${order.provider}`}
      itemSubtitle={new Date(order.updatedAt).toLocaleString()}
      rows={rampOrderToDetailRows(order)}
    />,
  );
}

/** A quote-only summary — no order is created. */
function renderQuoteResult(quote: QuoteBreakdown): string {
  return renderToStaticMarkup(
    <div style={{ width: "100%", maxWidth: 420, boxSizing: "border-box", margin: "0 auto", background: "#fff", borderRadius: 16, padding: 20, fontFamily: "Helvetica, Arial, sans-serif", color: "#111827" }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
        {quote.asset} · {quote.currency}
      </div>
      {quoteToSummaryRows(quote).map((row, i) => (
        <SummaryRow key={i} {...row} />
      ))}
    </div>,
  );
}

// ---------------------------------------------------------------------------
// Finalize an order: run the shared settlement function directly (used for
// Live/Etherfuse confirmations, which never go through ramp.handleWebhook —
// see confirmOrder).
// ---------------------------------------------------------------------------

async function finalizeOrder(ramp: CosmosRamp, order: RampOrderData): Promise<RampOrderData> {
  await ramp.store.update(order.id, { status: "paid" });
  const settling = (await ramp.store.update(order.id, { status: "settling" }))!;
  const result = await settlementFn({ order: settling, asset: settling.quote.asset, amount: settling.quote.cryptoAmount, wallet: settling.wallet });
  return (await ramp.store.update(order.id, { status: "completed", settlementTxId: result?.txId }))!;
}

/**
 * Confirms payment for an order, however that's actually possible:
 * - Etherfuse: triggers the REAL sandbox deposit simulation
 *   (`client.sandbox.fiatReceived`), then finalizes directly — Etherfuse has
 *   no local webhook to receive, sandbox or not.
 * - Live Mercado Pago: polls the REAL charge status — no webhook is
 *   fabricated, so this only completes once someone has genuinely paid.
 * - Simulated Mercado Pago: the existing mock webhook flow.
 */
async function confirmOrder(mode: Mode, orderId: string): Promise<{ resultHtml?: string; pending?: boolean }> {
  const ramp = rampFor(mode);
  const order = await ramp.getOrder(orderId);
  if (!order?.charge) throw new Error("Order not found or has no charge.");

  if (order.provider.startsWith("etherfuse")) {
    await etherfuseProvider.client.sandbox.fiatReceived(order.charge.id);
    const updated = await finalizeOrder(ramp, order);
    return { resultHtml: renderReceipt(updated) };
  }

  if (mode === "live") {
    const provider = ramp.providers.find((p) => p.name === order.provider);
    if (!provider) throw new Error(`Provider ${order.provider} is not registered in live mode.`);
    const state = await provider.getCharge(order.charge.id);
    if (state.status !== "approved") return { pending: true };
    const updated = await finalizeOrder(ramp, order);
    return { resultHtml: renderReceipt(updated) };
  }

  await ramp.handleWebhook("mercadopago", mp.pay(order.charge.id));
  const updated = await ramp.getOrder(orderId);
  if (!updated) throw new Error("Order disappeared after payment.");
  return { resultHtml: renderReceipt(updated) };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

type Action = (body: any) => Promise<unknown>;

const actions: Record<string, Action> = {
  /** Creates the onramp charge for the chosen provider/currency/method/amount and returns the pending-payment view. */
  async checkout(body) {
    const mode: Mode = body.mode === "live" ? "live" : "simulated";
    const ramp = rampFor(mode);
    const providerName = ramp.providers.some((p) => p.name === body.provider) ? body.provider : ramp.providers[0]!.name;
    const currency: Currency = body.currency === "ARS" ? "ARS" : "BRL";
    const method: Method = currency === "BRL" && body.method === "qr" ? "qr" : "link";
    const range = currency === "BRL" ? BRL_TEST_RANGE : ARS_TEST_RANGE;
    const requested = Number(body.amount);
    const amount = Number.isFinite(requested) ? clamp(requested, range[0], range[1]) : randomAmount(range[0], range[1]);
    const lang: Lang = STRINGS[body.lang as Lang] ? body.lang : "en";

    const order = await ramp.onramp({
      provider: providerName,
      amount,
      currency: currency === "BRL" ? FiatCurrency.BRL : FiatCurrency.ARS,
      spread: 0.02,
      wallet: await demoWallet(),
      method,
      description: "Buy USDC (demo)",
    });
    return { orderId: order.id, resultHtml: await renderPending(order, lang) };
  },

  async confirm(body) {
    const mode: Mode = body.mode === "live" ? "live" : "simulated";
    return confirmOrder(mode, body.orderId);
  },

  /** Creates an offramp order (crypto → fiat) and returns the "waiting for your USDC" view. */
  async sell(body) {
    const mode: Mode = body.mode === "live" ? "live" : "simulated";
    const ramp = rampFor(mode);
    const providerName = providersFor("sell", mode).some((p) => p.name === body.provider) ? body.provider : providersFor("sell", mode)[0]!.name;
    const currency: Currency = body.currency === "ARS" ? "ARS" : "BRL";
    const requested = Number(body.amount);
    const cryptoAmount = Number.isFinite(requested) ? clamp(requested, CRYPTO_TEST_RANGE[0], CRYPTO_TEST_RANGE[1]) : randomAmount(CRYPTO_TEST_RANGE[0], CRYPTO_TEST_RANGE[1]);
    const lang: Lang = STRINGS[body.lang as Lang] ? body.lang : "en";

    const order = await ramp.offramp({
      provider: providerName,
      cryptoAmount,
      currency: currency === "BRL" ? FiatCurrency.BRL : FiatCurrency.ARS,
      spread: 0.02,
      destination: { email: "seller@example.com" },
    });
    return { orderId: order.id, resultHtml: renderSellPending(order, lang) };
  },

  /** Simulates the seller's crypto arriving → triggers the fiat payout → returns the receipt view. */
  async sellConfirm(body) {
    const mode: Mode = body.mode === "live" ? "live" : "simulated";
    const ramp = rampFor(mode);
    const order = await ramp.confirmCryptoReceived(body.orderId, { txId: "0xincoming-demo" });
    return { resultHtml: renderReceipt(order) };
  },

  /** Pure quote — no order created. Pricing is oracle-based, not provider-specific; `provider` is accepted for UI consistency. */
  async quote(body) {
    const mode: Mode = body.mode === "live" ? "live" : "simulated";
    const ramp = rampFor(mode);
    const currency: Currency = body.currency === "ARS" ? "ARS" : "BRL";
    const range = currency === "BRL" ? BRL_TEST_RANGE : ARS_TEST_RANGE;
    const requested = Number(body.amount);
    const amount = Number.isFinite(requested) ? clamp(requested, range[0], range[1]) : randomAmount(range[0], range[1]);

    const quote = await ramp.quote({
      direction: "onramp",
      currency: currency === "BRL" ? FiatCurrency.BRL : FiatCurrency.ARS,
      amount,
      spread: 0.02,
    });
    return { resultHtml: renderQuoteResult(quote) };
  },
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = { ".svg": "image/svg+xml" };

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/assets/flag/")) {
    const code = path.basename(url.pathname, ".svg").replace(/[^a-z]/gi, "");
    try {
      const svg = readFileSync(path.join(FLAGS_DIR, `${code}.svg`));
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }).end(svg);
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/assets/logo/")) {
    const name = path.basename(url.pathname);
    const ext = path.extname(name);
    try {
      const svg = readFileSync(path.join(LOGOS_DIR, name));
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "public, max-age=86400" }).end(svg);
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/step") {
    const op: Op = url.searchParams.get("op") === "sell" ? "sell" : url.searchParams.get("op") === "quote" ? "quote" : "buy";
    const mode: Mode = url.searchParams.get("mode") === "live" ? "live" : "simulated";
    const stepName = url.searchParams.get("step") || "provider";
    const lang: Lang = STRINGS[url.searchParams.get("lang") as Lang] ? (url.searchParams.get("lang") as Lang) : "en";
    const amountParam = url.searchParams.get("amount");
    const defaultProvider = providersFor(op, mode)[0]?.name ?? rampFor(mode).providers[0]!.name;
    const state: WizardState = {
      provider: url.searchParams.get("provider") || defaultProvider,
      currency: url.searchParams.get("currency") === "BRL" ? "BRL" : url.searchParams.get("currency") === "ARS" ? "ARS" : null,
      method: url.searchParams.get("method") === "qr" ? "qr" : url.searchParams.get("method") === "link" ? "link" : null,
      amount: amountParam ? Number(amountParam) : null,
    };
    const providers = providersFor(op, mode).map((p) => ({ name: p.name, currencies: p.currencies }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ html: renderStep(op, stepName, state, lang, mode), providers }));
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice("/api/".length);
    const action = actions[name];
    if (!action) {
      res.writeHead(404).end(JSON.stringify({ error: `Unknown action ${name}` }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      try {
        const result = await action(raw ? JSON.parse(raw) : {});
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String((error as Error).message ?? error) }));
      }
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`Demo UI running → http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Page (vanilla HTML/JS shell — the payment views inside #view are the real
// cosmos-providers/react components, server-rendered per request above)
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER = providersFor("buy", "simulated")[0]!.name;
const INITIAL_PROVIDERS = JSON.stringify(providersFor("buy", "simulated").map((p) => ({ name: p.name, currencies: p.currencies })));

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cosmos demo</title>
<style>
  * { box-sizing: border-box; }
  :root {
    --bg: #F3F4F6; --fg: #111827; --muted: #6B7280; --panel: #fff; --border: #E5E7EB;
  }
  html[data-theme="dark"] {
    --bg: #0f1220; --fg: #e8e9f0; --muted: #9aa0b8; --panel: #171b31; --border: #2d3560;
  }
  body {
    font: 14px/1.5 system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--fg);
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    transition: background .2s ease, color .2s ease;
  }
  main { width: 100%; max-width: 420px; }
  .pickable { cursor: pointer; }
  .pickable:hover { filter: brightness(0.98); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #E5E7EB; }
  .dot.active { background: #111827; }
  button.back { background: none; border: none; color: #6B7280; font-size: 12px; cursor: pointer; padding: 0; font: inherit; }
  #confirmBar button {
    display: block; width: 100%; padding: 14px; border-radius: 16px; border: none;
    background: #16A34A; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; font: inherit;
  }
  #confirmBar button:disabled { opacity: .6; cursor: default; }
  #restart {
    display: block; margin: 16px auto 0; background: none; border: none;
    color: var(--muted); font-size: 13px; text-decoration: underline; cursor: pointer; font: inherit;
  }
  #hint { text-align: center; color: var(--muted); font-size: 12px; margin-top: 16px; }
  #pending-note { text-align: center; color: #B45309; font-size: 12px; margin-top: 8px; }

  /* Top-left: Live/Simulated pill. Top-right: flags + theme toggle. */
  #mode-switch, #top-right { position: fixed; top: 20px; z-index: 50; display: flex; gap: 8px; align-items: center; }
  #mode-switch { left: 20px; }
  #top-right { right: 20px; }
  .pill { display: flex; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); background: var(--panel); }
  .pill button {
    background: none; border: none; padding: 6px 10px; font-size: 12px; cursor: pointer; font: inherit; color: var(--fg);
  }
  .pill button.active { background: #111827; color: #fff; }
  .pill button + button { border-left: 1px solid var(--border); }
  #lang-switch img { width: 20px; height: 15px; display: block; }
  #lang-switch button { padding: 6px 8px; display: flex; align-items: center; }
  #theme-toggle { padding: 6px 10px; font-size: 12px; }
  #live-warning { font-size: 10px; color: #B45309; margin-left: 6px; max-width: 140px; }

  /* Operation picker FAB (bottom-right) */
  #fab-wrap { position: fixed; right: 20px; bottom: 20px; z-index: 50; }
  #fab {
    width: 56px; height: 56px; border-radius: 50%; background: #111827; color: #fff; border: none;
    font-size: 20px; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.18);
  }
  .fab-menu {
    position: absolute; bottom: 68px; right: 0; background: var(--panel); border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 6px; display: none; flex-direction: column; gap: 2px; min-width: 180px;
  }
  .fab-menu.open { display: flex; }
  .fab-menu .menu-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; padding: 6px 10px 2px; }
  .fab-menu button { background: none; border: none; text-align: left; padding: 10px 12px; border-radius: 8px; font-size: 13px; cursor: pointer; font: inherit; color: var(--fg); }
  .fab-menu button:hover, .fab-menu button.current { background: rgba(127,127,127,.15); }

  /* Animated transitions between steps/results */
  @keyframes viewEnter { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
  @keyframes viewLeave { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-8px) scale(.98); } }
  #view > *, #actions > * { animation: viewEnter .3s cubic-bezier(.16,1,.3,1) both; }
  #view > *.leaving, #actions > *.leaving { animation: viewLeave .15s ease both !important; }
</style>
</head>
<body>
<div id="mode-switch">
  <div class="pill">
    <button class="active" data-mode="simulated" onclick="setMode('simulated')" id="modeSimBtn">Simulated</button>
    <button data-mode="live" onclick="setMode('live')" id="modeLiveBtn">Live</button>
  </div>
  <span id="live-warning" style="display:none"></span>
</div>
<div id="top-right">
  <div class="pill" id="lang-switch">
    <button class="active" data-lang="en" onclick="setLang('en')"><img src="/assets/flag/us.svg" alt="EN" /></button>
    <button data-lang="es" onclick="setLang('es')"><img src="/assets/flag/es.svg" alt="ES" /></button>
    <button data-lang="pt" onclick="setLang('pt')"><img src="/assets/flag/br.svg" alt="PT" /></button>
  </div>
  <button class="pill" id="theme-toggle" onclick="toggleTheme()">Dark</button>
</div>
<main>
  <div id="view">${renderStep("buy", "provider", { provider: DEFAULT_PROVIDER, currency: null, method: null, amount: null }, "en", "simulated")}</div>
  <div id="actions"></div>
  <p id="hint">Mercado Pago is simulated by default; switch to Live (top-left) to use real credentials from .env.</p>
</main>
<div id="fab-wrap">
  <div id="fab-menu" class="fab-menu"></div>
  <button id="fab" onclick="toggleFab()" aria-label="Choose operation">☰</button>
</div>
<script>
  var STEPS = ${JSON.stringify(STEPS)};
  var STR_DICT = ${JSON.stringify(STRINGS)};
  var lang = 'en';
  var mode = 'simulated';
  var op = 'buy';
  var uiMode = 'wizard';
  var stepIdx = 0;
  var state = { provider: ${JSON.stringify(DEFAULT_PROVIDER)}, currency: null, method: null, amount: null };
  var orderId = null;
  var PROVIDER_META = {};
  ${INITIAL_PROVIDERS}.forEach(function (p) { PROVIDER_META[p.name] = p; });

  function STR(key) { return (STR_DICT[lang] && STR_DICT[lang][key]) || key; }
  function methodsFor(provider, currency) {
    if (provider && provider.indexOf('etherfuse') === 0) return ['link'];
    return currency === 'BRL' ? ['qr', 'link'] : ['link'];
  }
  function currenciesFor(provider) {
    var meta = PROVIDER_META[provider];
    return meta ? meta.currencies : ['ARS', 'BRL'];
  }

  function swapView(containerId, html) {
    var el = document.getElementById(containerId);
    var current = el.firstElementChild;
    if (current) {
      current.classList.add('leaving');
      setTimeout(function () { el.innerHTML = html; }, 150);
    } else {
      el.innerHTML = html;
    }
  }

  async function fetchStep() {
    var stepName = STEPS[op][stepIdx];
    var qs = new URLSearchParams({ op: op, step: stepName, lang: lang, mode: mode, provider: state.provider || '' });
    if (state.currency) qs.set('currency', state.currency);
    if (state.method) qs.set('method', state.method);
    if (state.amount != null) qs.set('amount', String(state.amount));
    var res = await fetch('/api/step?' + qs.toString());
    var data = await res.json();
    PROVIDER_META = {};
    (data.providers || []).forEach(function (p) { PROVIDER_META[p.name] = p; });
    if (data.providers && data.providers.length && !data.providers.some(function (p) { return p.name === state.provider; })) {
      state.provider = data.providers[0].name;
    }
    swapView('view', data.html);
  }

  async function selectStep(field, value) {
    state[field] = value;
    if (field === 'provider') {
      var currencies = currenciesFor(value);
      if (currencies.length === 1) {
        state.currency = currencies[0];
        var methods = methodsFor(value, currencies[0]);
        if (methods.length === 1) {
          state.method = methods[0];
          stepIdx = STEPS[op].indexOf('amount');
          await fetchStep();
          return;
        }
        stepIdx = STEPS[op].indexOf('method');
        await fetchStep();
        return;
      }
    }
    if (field === 'currency') {
      var methods2 = methodsFor(state.provider, value);
      if (methods2.length === 1) {
        state.method = methods2[0];
        stepIdx = STEPS[op].indexOf('amount');
        await fetchStep();
        return;
      }
    }
    stepIdx++;
    await fetchStep();
  }

  function goBack() {
    if (stepIdx === 0) return;
    stepIdx--;
    var name = STEPS[op][stepIdx];
    if (name === 'currency' && currenciesFor(state.provider).length === 1) stepIdx--;
    else if (name === 'method' && methodsFor(state.provider, state.currency).length === 1) stepIdx--;
    fetchStep();
  }

  async function submitStep() {
    var amountInput = document.getElementById('amountInput');
    state.amount = amountInput ? Number(amountInput.value) : null;
    var btn = document.querySelector('#view button:not(.back)');
    if (btn) btn.disabled = true;
    var endpoint = op === 'buy' ? 'checkout' : op === 'sell' ? 'sell' : 'quote';
    var res = await fetch('/api/' + endpoint, {
      method: 'POST',
      body: JSON.stringify({ provider: state.provider, currency: state.currency, method: state.method, amount: state.amount, lang: lang, mode: mode }),
    });
    var data = await res.json();
    if (data.error) {
      if (btn) btn.disabled = false;
      alert(data.error);
      return;
    }
    uiMode = 'result';
    orderId = data.orderId || null;
    swapView('view', data.resultHtml);
    var confirmLabel = op === 'buy'
      ? (state.provider.indexOf('etherfuse') === 0 ? STR('simulatePaymentSandbox') : mode === 'live' ? STR('checkStatus') : STR('ivePaid'))
      : op === 'sell'
        ? (state.provider.indexOf('etherfuse') === 0 ? STR('simulatePaymentSandbox') : mode === 'live' ? STR('checkStatus') : STR('iveSent'))
        : null;
    if (confirmLabel) {
      var confirmFn = op === 'sell' ? 'confirmSell()' : 'confirmBuy()';
      swapView('actions', '<div id="confirmBar"><button onclick="' + confirmFn + '">' + confirmLabel + '</button></div><button id="restart" onclick="location.reload()">' + STR('startOver') + '</button>');
    } else {
      swapView('actions', '<button id="restart" onclick="location.reload()">' + STR('startOver') + '</button>');
    }
  }

  async function pollConfirm(endpoint) {
    var btn = document.querySelector('#confirmBar button');
    btn.disabled = true;
    btn.textContent = '…';
    var res = await fetch('/api/' + endpoint, { method: 'POST', body: JSON.stringify({ orderId: orderId, lang: lang, mode: mode }) });
    var data = await res.json();
    var note = document.getElementById('pending-note');
    if (note) note.remove();
    if (data.error) { btn.disabled = false; alert(data.error); return; }
    if (data.pending) {
      btn.disabled = false;
      btn.textContent = STR('checkStatus');
      var p = document.createElement('p');
      p.id = 'pending-note';
      p.textContent = STR('stillPending');
      document.getElementById('actions').appendChild(p);
      return;
    }
    swapView('view', data.resultHtml);
    swapView('actions', '<button id="restart" onclick="location.reload()">' + STR('startOver') + '</button>');
  }
  function confirmBuy() { pollConfirm('confirm'); }
  function confirmSell() { pollConfirm('sellConfirm'); }

  function setLang(l) {
    lang = l;
    document.querySelectorAll('#lang-switch button').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-lang') === l);
    });
    if (uiMode === 'wizard') fetchStep();
  }

  function setMode(m) {
    mode = m;
    document.getElementById('modeSimBtn').classList.toggle('active', m === 'simulated');
    document.getElementById('modeLiveBtn').classList.toggle('active', m === 'live');
    var warn = document.getElementById('live-warning');
    warn.style.display = m === 'live' ? 'block' : 'none';
    warn.textContent = m === 'live' ? '⚠ real API calls' : '';
    if (uiMode === 'wizard') {
      state = { provider: state.provider, currency: null, method: null, amount: null };
      stepIdx = 0;
      fetchStep();
    }
  }

  function toggleTheme() {
    var html = document.documentElement;
    var next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    document.getElementById('theme-toggle').textContent = next === 'dark' ? STR('lightLabel') : STR('darkLabel');
  }

  function toggleFab() {
    var menu = document.getElementById('fab-menu');
    if (menu.classList.contains('open')) {
      menu.classList.remove('open');
      return;
    }
    menu.innerHTML =
      '<div class="menu-label">' + STR('chooseOperation') + '</div>' +
      '<button class="' + (op === 'buy' ? 'current' : '') + '" onclick="chooseOp(\\'buy\\')">' + STR('opBuy') + '</button>' +
      '<button class="' + (op === 'sell' ? 'current' : '') + '" onclick="chooseOp(\\'sell\\')">' + STR('opSell') + '</button>' +
      '<button class="' + (op === 'quote' ? 'current' : '') + '" onclick="chooseOp(\\'quote\\')">' + STR('opQuote') + '</button>';
    menu.classList.add('open');
  }

  function chooseOp(next) {
    op = next;
    stepIdx = 0;
    uiMode = 'wizard';
    orderId = null;
    state = { provider: state.provider, currency: null, method: null, amount: null };
    document.getElementById('actions').innerHTML = '';
    document.getElementById('fab-menu').classList.remove('open');
    fetchStep();
  }

  document.addEventListener('click', function (e) {
    var wrap = document.getElementById('fab-wrap');
    if (!wrap.contains(e.target)) document.getElementById('fab-menu').classList.remove('open');
  });
</script>
</body>
</html>`;
