/**
 * Local demo: a small "Cosmos" wizard that shows off the SDK's operations —
 * Buy USDC, Sell USDC, Get a quote — picked from a round button in the
 * bottom-right corner. Each operation walks through a few steps (provider →
 * currency → [method] → amount) built from `cosmos-providers/react`'s real
 * components (`PaymentMethodCard`, `PaymentOptionRow`, `ReceivePayment`,
 * `PaymentConfirmation`, `SummaryRow`), server-rendered with
 * `react-dom/server` and fed by the `cosmos-providers/react/server` mappers.
 * Steps animate in/out; the language dropdown (top-right, flags) and the
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
 * The UI always runs against the Mercado Pago simulator
 * (`examples/helpers/mock-mercadopago`) — safe, deterministic, no external
 * calls. There is deliberately no runtime Simulated/Live switch in the UI:
 * which credentials a provider talks to (sandbox vs. production) is a
 * property of how that provider was constructed (`.env`), not something a
 * user should be able to flip live. The server-side `mode: "live"` code path
 * still exists below for anyone hitting `/api/*` directly with real `.env`
 * credentials — see the actions for details — but nothing in the page wires
 * it up.
 * Because a local dev server can't receive real inbound webhooks, "confirm"
 * in Live mode polls the provider's real charge status instead of
 * simulating a webhook — it only completes once someone has genuinely paid.
 *
 * Once an order is created, the page polls `/api/status` (a pure read —
 * no side effects) every 5s waiting for it to land as `completed`, same as
 * a real integration waiting on its webhook handler to update the order
 * store. That's "Real" confirmation mode (the default, no button — just a
 * wait). The FAB's "Test" confirmation mode additionally surfaces a manual
 * "mark as paid" control that calls the existing forced-confirm actions
 * (`/api/confirm`, `/api/sellConfirm` — the mock-webhook/sandbox-deposit
 * simulation), so you can jump straight to the next stage instead of
 * waiting on a webhook this local demo has no way to receive on its own.
 * This is unrelated to the Simulated/Live provider-credentials axis above —
 * it only controls how THIS page decides an already-created order is done.
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
import { chargeToQrProps, rampOrderToDetailRows, quoteToSummaryRows, renderQrDataUrl } from "../../src/react/server";
import { createMockMercadoPago } from "../helpers/mock-mercadopago";

const PORT = 4000;
const WEBHOOK_SECRET = "demo-mp-secret";

type Op = "buy" | "sell" | "quote";
type Method = "qr" | "link";
type Currency = "ARS" | "BRL" | "MXN";
type Lang = "en" | "es" | "pt";
type Mode = "simulated" | "live";
interface WizardState {
  provider: string | null;
  currency: Currency | null;
  method: Method | null;
  amount: number | null;
}

/** Sensible unprompted starting points (~10 USD) — not enforced limits, just a reasonable prefill per currency. */
const DEFAULT_FIAT_AMOUNT: Record<Currency, number> = { ARS: 2000, BRL: 20, MXN: 300 };
const DEFAULT_CRYPTO_AMOUNT = 10;

const parseCurrency = (v: unknown): Currency => (v === "ARS" ? "ARS" : v === "MXN" ? "MXN" : "BRL");
const toFiatCurrency = (c: Currency): FiatCurrency => (c === "ARS" ? FiatCurrency.ARS : c === "MXN" ? FiatCurrency.MXN : FiatCurrency.BRL);

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
    mxn: "Mexican Peso (MXN)",
    pix: "PIX QR",
    link: "Payment link",
    amountFiat: "Amount",
    amountCrypto: "Amount (USDC)",
    checkStatus: "Check status",
    stillPending: "Still pending — try again in a moment.",
    genericError: "Something went wrong. Please try again.",
    waitingPayment: "Waiting for payment",
    waitingCrypto: "Waiting for your USDC",
    step: "Step",
    of: "of",
    chooseOperation: "Choose an operation",
    confirmationMode: "Confirmation mode",
    modeReal: "Real — wait for webhook",
    modeDev: "Test — mark as paid manually",
    markAsPaid: "Mark as paid (simulate)",
    markAsReceived: "Mark as received (simulate)",
    youPay: "You pay",
    youReceive: "You receive",
    rateNote: "1 USDC ≈",
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
    mxn: "Peso Mexicano (MXN)",
    pix: "QR PIX",
    link: "Link de pago",
    amountFiat: "Monto",
    amountCrypto: "Monto (USDC)",
    checkStatus: "Verificar estado",
    stillPending: "Todavía pendiente — probá de nuevo en un momento.",
    genericError: "Algo salió mal. Probá de nuevo.",
    waitingPayment: "Esperando el pago",
    waitingCrypto: "Esperando tu USDC",
    step: "Paso",
    of: "de",
    chooseOperation: "Elegí una operación",
    confirmationMode: "Modo de confirmación",
    modeReal: "Real — esperar webhook",
    modeDev: "Prueba — marcar como pagado a mano",
    markAsPaid: "Marcar como pagado (simular)",
    markAsReceived: "Marcar como recibido (simular)",
    youPay: "Pagás",
    youReceive: "Recibís",
    rateNote: "1 USDC ≈",
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
    mxn: "Peso Mexicano (MXN)",
    pix: "QR PIX",
    link: "Link de pagamento",
    amountFiat: "Valor",
    amountCrypto: "Valor (USDC)",
    checkStatus: "Verificar status",
    stillPending: "Ainda pendente — tente novamente em instantes.",
    genericError: "Algo deu errado. Tente novamente.",
    waitingPayment: "Aguardando pagamento",
    waitingCrypto: "Aguardando seu USDC",
    step: "Etapa",
    of: "de",
    chooseOperation: "Escolha uma operação",
    confirmationMode: "Modo de confirmação",
    modeReal: "Real — aguardar webhook",
    modeDev: "Teste — marcar como pago manualmente",
    markAsPaid: "Marcar como pago (simular)",
    markAsReceived: "Marcar como recebido (simular)",
    youPay: "Você paga",
    youReceive: "Você recebe",
    rateNote: "1 USDC ≈",
  },
};
const t = (lang: Lang, key: string): string => STRINGS[lang]?.[key] ?? key;

const PROVIDER_DISPLAY_NAME: Record<string, string> = {
  etherfuse: "Etherfuse",
  "mercadopago-br": "Mercado Pago Brasil",
  "mercadopago-ar": "Mercado Pago Argentina",
};
const providerLabel = (name: string): string => PROVIDER_DISPLAY_NAME[name] ?? name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, " ");
const currencyLabelKey = (c: Currency): string => (c === "ARS" ? "ars" : c === "MXN" ? "mxn" : "brl");
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
const LOGOS_DIR = path.join(HERE, "..", "..", "src", "react", "images");
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

// Etherfuse settles both Brazil (PIX/BRL) and Mexico (SPEI/MXN), so both
// currencies show up in the picker and both build a real charge — BRL
// delivers Asset.TESOURO, MXN delivers Asset.CETES (see EtherfuseProvider's docstring).
const etherfuseProvider = new EtherfuseProvider({
  apiKey: process.env.ETHERFUSE_API_KEY ?? "",
  environment: "sandbox",
  regions: ["BR", "MX"],
  currencies: [FiatCurrency.BRL, FiatCurrency.MXN],
  logoUrl: "/assets/logo/etherfuse.ico",
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
      logoUrl: "/assets/logo/mp.svg",
    }),
    new MercadoPagoProvider({
      name: "mercadopago-ar",
      regions: ["AR"],
      currencies: [FiatCurrency.ARS],
      accessToken: "TEST-demo-ar",
      webhookSecret: WEBHOOK_SECRET,
      defaultPayerEmail: "buyer@example.com",
      fetch: mp.fetchImpl,
      logoUrl: "/assets/logo/mp.svg",
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
      logoUrl: "/assets/logo/mp.svg",
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
      logoUrl: "/assets/logo/mp.svg",
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
  return `<div style="width:100%;max-width:420px;box-sizing:border-box;margin:0 auto;background:var(--panel);border-radius:24px;padding:24px;font-family:Helvetica, Arial, sans-serif;color:var(--fg)">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      ${backBtn}
      <span style="font-size:11px;color:var(--muted)">${t(lang, "step")} ${idx + 1} ${t(lang, "of")} ${steps.length}</span>
    </div>
    <div style="display:flex;gap:4px;justify-content:center;margin-bottom:16px">${dots}</div>
    <h1 style="font-size:20px;margin:0 0 4px;text-align:center">${t(lang, opTitleKey)}</h1>
    <p style="color:var(--muted);margin:0 0 20px;font-size:13px;text-align:center">${t(lang, subtitleKey)}</p>
    <div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">${t(lang, stepLabelKey)}</div>
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
          radioColor={p.name === state.provider ? "var(--cosmos-fg, #111827)" : "var(--cosmos-radio, #D1D5DB)"}
        />,
      );
      return `<div class="pickable" onclick="selectStep('provider','${p.name}')">${card}</div>`;
    })
    .join("");
  return `<div style="display:flex;flex-direction:column;gap:8px">${rows}</div>`;
}

function renderCurrencyBody(op: Op, mode: Mode, state: WizardState, lang: Lang): string {
  const provider = providersFor(op, mode).find((p) => p.name === state.provider);
  const currencies = (provider?.currencies.length ? (provider.currencies as Currency[]) : (["ARS", "BRL"] as const)) as readonly Currency[];
  const rows = currencies
    .map((c) => {
      const row = renderToStaticMarkup(
        <PaymentOptionRow label={t(lang, currencyLabelKey(c))} selected={c === state.currency} radioColor={c === state.currency ? "#4F46E5" : "var(--cosmos-radio, #D1D5DB)"} />,
      );
      return `<div class="pickable" onclick="selectStep('currency','${c}')">${row}</div>`;
    })
    .join("");
  return `<div style="display:flex;flex-direction:column;gap:8px">${rows}</div>`;
}

function renderMethodBody(state: WizardState, lang: Lang): string {
  const methods = methodsForProvider(state.provider ?? "", state.currency ?? "ARS");
  const rows = methods
    .map((m) => {
      const row = renderToStaticMarkup(
        <PaymentOptionRow label={t(lang, m === "qr" ? "pix" : "link")} selected={m === state.method} radioColor={m === state.method ? "#4F46E5" : "var(--cosmos-radio, #D1D5DB)"} />,
      );
      return `<div class="pickable" onclick="selectStep('method','${m}')">${row}</div>`;
    })
    .join("");
  return `<div style="display:flex;flex-direction:column;gap:8px">${rows}</div>`;
}

const FIELD_STYLE =
  "width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:14px;margin-bottom:20px;background:var(--panel);color:var(--fg)";
const FIELD_STYLE_TIGHT =
  "width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:14px;margin-bottom:12px;background:var(--panel);color:var(--fg)";
const BUTTON_STYLE =
  "width:100%;background:var(--cosmos-button-bg);color:var(--cosmos-button-fg);border:none;border-radius:16px;padding:16px;font-size:16px;font-weight:700;cursor:pointer";

function renderSellAmountBody(state: WizardState, lang: Lang): string {
  const value = state.amount ?? DEFAULT_CRYPTO_AMOUNT;
  return `<label style="display:block;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px">${t(lang, "amountCrypto")}</label>
    <input id="amountInput" type="number" min="0" step="0.01" value="${value}" style="${FIELD_STYLE}" />
    <button onclick="submitStep()" style="${BUTTON_STYLE}">${t(lang, "continueLabel")}</button>`;
}

function renderQuoteAmountBody(state: WizardState, lang: Lang): string {
  const currency = state.currency ?? "ARS";
  const value = state.amount ?? DEFAULT_FIAT_AMOUNT[currency];
  return `<label style="display:block;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px">${t(lang, "amountFiat")} (${currency})</label>
    <input id="amountInput" type="number" min="0" step="0.01" value="${value}" style="${FIELD_STYLE}" />
    <button onclick="submitStep()" style="${BUTTON_STYLE}">${t(lang, "getQuoteLabel")}</button>`;
}

/** Live, two-way pay/receive quote: editing either field re-quotes the other via /api/quote-preview. */
async function renderBuyAmountBody(mode: Mode, state: WizardState, lang: Lang): Promise<string> {
  const ramp = rampFor(mode);
  const currency = state.currency ?? "ARS";
  const fiatDefault = state.amount ?? DEFAULT_FIAT_AMOUNT[currency];
  let quote: QuoteBreakdown | null = null;
  try {
    quote = await ramp.quote({ direction: "onramp", currency: toFiatCurrency(currency), amount: fiatDefault, spread: 0.02 });
  } catch {
    quote = null;
  }
  const fiatValue = quote ? quote.fiatAmount : fiatDefault;
  const cryptoValue = quote ? quote.cryptoAmount : "";
  const rate = quote ? quote.effectiveRate.toFixed(4) : "…";
  return `<label style="display:block;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px">${t(lang, "youPay")} (${currency})</label>
    <input id="payAmount" type="number" min="0" step="0.01" value="${fiatValue}" oninput="scheduleQuote('fiat')" style="${FIELD_STYLE_TIGHT}" />
    <label style="display:block;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px">${t(lang, "youReceive")} (USDC)</label>
    <input id="receiveAmount" type="number" min="0" step="0.000001" value="${cryptoValue}" oninput="scheduleQuote('crypto')" style="${FIELD_STYLE_TIGHT}" />
    <p id="rateNote" style="text-align:center;color:var(--muted);font-size:12px;margin:0 0 20px">${t(lang, "rateNote")} ${rate} ${currency}</p>
    <button onclick="submitStep()" style="${BUTTON_STYLE}">${t(lang, "continueLabel")}</button>`;
}

async function renderStep(op: Op, stepName: string, state: WizardState, lang: Lang, mode: Mode): Promise<string> {
  const body =
    stepName === "provider"
      ? renderProviderBody(op, mode, state)
      : stepName === "currency"
        ? renderCurrencyBody(op, mode, state, lang)
        : stepName === "method"
          ? renderMethodBody(state, lang)
          : op === "sell"
            ? renderSellAmountBody(state, lang)
            : op === "quote"
              ? renderQuoteAmountBody(state, lang)
              : await renderBuyAmountBody(mode, state, lang);
  return wizardShell(op, lang, stepName, body);
}

// ---------------------------------------------------------------------------
// Result views — all built from cosmos-providers/react's actual components.
// ---------------------------------------------------------------------------

/**
 * The real QR/payment-link view a buyer would see: a PIX (or other direct)
 * charge renders its own scannable QR; a hosted-checkout charge has no such
 * code, so we render a QR of the payment link itself — "continue from your
 * phone" — pre-rendered here server-side since this demo has no client-side
 * React hydration to generate it on the fly.
 */
async function renderPending(order: RampOrderData, lang: Lang): Promise<string> {
  const qr = await chargeToQrProps(order.charge, { width: 240 });
  const link = order.charge?.link;
  const linkQr = !qr && link ? { src: await renderQrDataUrl(link, { width: 240 }) } : undefined;
  return renderToStaticMarkup(
    <ReceivePayment
      locale={lang}
      amount={`${order.quote.fiatAmount.toFixed(2)} ${order.quote.currency}`}
      statusLabel={t(lang, "waitingPayment")}
      statusColor="#9CA3AF"
      qr={qr ?? linkQr}
      qrIsPaymentLink={!qr && !!linkQr}
      paymentLink={link}
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
    <div style={{ width: "100%", maxWidth: 420, boxSizing: "border-box", margin: "0 auto", background: "var(--panel, #fff)", borderRadius: 16, padding: 20, fontFamily: "Helvetica, Arial, sans-serif", color: "var(--fg, #111827)" }}>
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
    const currency = parseCurrency(body.currency);
    const method: Method = currency === "BRL" && body.method === "qr" ? "qr" : "link";
    const requested = Number(body.amount);
    const amount = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_FIAT_AMOUNT[currency];
    const lang: Lang = STRINGS[body.lang as Lang] ? body.lang : "en";

    const order = await ramp.onramp({
      provider: providerName,
      amount,
      currency: toFiatCurrency(currency),
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

  /**
   * Pure read for the "Real" confirmation mode's 5s poll — unlike `confirm`/
   * `sellConfirm`, this never forces a payment or crypto-received event, it
   * only reports whatever the order's current status already is. A real
   * integration would land the same state via its webhook handler updating
   * the order store; polling this is how the page notices without one.
   */
  async status(body) {
    const mode: Mode = body.mode === "live" ? "live" : "simulated";
    const order = await rampFor(mode).getOrder(body.orderId);
    if (!order) throw new Error("Order not found.");
    if (order.status === "completed") return { done: true, resultHtml: renderReceipt(order) };
    if (order.status === "failed" || order.status === "expired" || order.status === "canceled") {
      return { done: true, failed: true };
    }
    return { done: false };
  },

  /** Creates an offramp order (crypto → fiat) and returns the "waiting for your USDC" view. */
  async sell(body) {
    const mode: Mode = body.mode === "live" ? "live" : "simulated";
    const ramp = rampFor(mode);
    const providerName = providersFor("sell", mode).some((p) => p.name === body.provider) ? body.provider : providersFor("sell", mode)[0]!.name;
    const currency = parseCurrency(body.currency);
    const requested = Number(body.amount);
    const cryptoAmount = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CRYPTO_AMOUNT;
    const lang: Lang = STRINGS[body.lang as Lang] ? body.lang : "en";

    const order = await ramp.offramp({
      provider: providerName,
      cryptoAmount,
      currency: toFiatCurrency(currency),
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
    const currency = parseCurrency(body.currency);
    const requested = Number(body.amount);
    const amount = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_FIAT_AMOUNT[currency];

    const quote = await ramp.quote({
      direction: "onramp",
      currency: toFiatCurrency(currency),
      amount,
      spread: 0.02,
    });
    return { resultHtml: renderQuoteResult(quote) };
  },
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = { ".svg": "image/svg+xml", ".ico": "image/x-icon" };

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
    const currencyParam = url.searchParams.get("currency");
    const state: WizardState = {
      provider: url.searchParams.get("provider") || null,
      currency: currencyParam ? parseCurrency(currencyParam) : null,
      method: url.searchParams.get("method") === "qr" ? "qr" : url.searchParams.get("method") === "link" ? "link" : null,
      amount: amountParam ? Number(amountParam) : null,
    };
    const providers = providersFor(op, mode).map((p) => ({ name: p.name, currencies: p.currencies }));
    const html = await renderStep(op, stepName, state, lang, mode);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ html, providers }));
    return;
  }
  /** Live re-quote for the buy amount step: pass either `amount` (fiat) or `cryptoAmount`, get the other back. Provider-agnostic — pricing is oracle-based. */
  if (req.method === "GET" && url.pathname === "/api/quote-preview") {
    const mode: Mode = url.searchParams.get("mode") === "live" ? "live" : "simulated";
    const currency = parseCurrency(url.searchParams.get("currency"));
    const amountParam = url.searchParams.get("amount");
    const cryptoParam = url.searchParams.get("cryptoAmount");
    try {
      const quote = await rampFor(mode).quote({
        direction: "onramp",
        currency: toFiatCurrency(currency),
        amount: amountParam ? Number(amountParam) : undefined,
        cryptoAmount: cryptoParam ? Number(cryptoParam) : undefined,
        spread: 0.02,
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ quote }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String((error as Error).message ?? error) }));
    }
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
    /* cosmos-providers/react screens read these (with light-mode fallbacks baked
       into each var() call, so they're optional for any other consumer) — aliasing
       them to the vars above means one theme definition drives both this page's
       own markup and the library's server-rendered screens. */
    --cosmos-bg-soft: #F7F7F8;
    --cosmos-panel: var(--panel);
    --cosmos-fg: var(--fg);
    --cosmos-muted: var(--muted);
    --cosmos-border: var(--border);
    --cosmos-button-bg: #111827;
    --cosmos-button-fg: #fff;
    --cosmos-surface-alt: #F3F4F6;
    --cosmos-radio: #D1D5DB;
  }
  html[data-theme="dark"] {
    --bg: #0f1220; --fg: #e8e9f0; --muted: #9aa0b8; --panel: #171b31; --border: #2d3560;
    --cosmos-bg-soft: #1b2040;
    --cosmos-button-bg: #e8e9f0;
    --cosmos-button-fg: #0f1220;
    --cosmos-surface-alt: #232a4d;
    --cosmos-radio: #3a4270;
  }
  body {
    font: 14px/1.5 system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--fg);
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    transition: background .2s ease, color .2s ease;
  }
  main { width: 100%; max-width: 420px; }
  .pickable { cursor: pointer; }
  .pickable:hover { filter: brightness(0.98); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border); }
  .dot.active { background: var(--fg); }
  button.back { background: none; border: none; color: var(--muted); font-size: 12px; cursor: pointer; padding: 0; font: inherit; }
  #confirmBar button {
    display: block; width: 100%; padding: 14px; border-radius: 16px; border: none;
    background: #16A34A; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; font: inherit;
  }
  button:disabled { opacity: .65; cursor: default !important; }
  .btn-spinner {
    display: inline-block; width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: btnSpin .6s linear infinite;
  }
  @keyframes btnSpin { to { transform: rotate(360deg); } }
  #pending-note { text-align: center; color: #B45309; font-size: 12px; margin-top: 8px; }

  /* Toasts (errors / confirmations) */
  #toast-stack {
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 100;
    display: flex; flex-direction: column; gap: 8px; align-items: stretch;
    width: 100%; max-width: 360px; padding: 0 16px; pointer-events: none;
  }
  .toast {
    pointer-events: auto; display: flex; align-items: flex-start; gap: 10px;
    background: var(--panel); color: var(--fg); border: 1px solid var(--border); border-left: 4px solid #DC2626;
    border-radius: 12px; padding: 12px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.16);
    font-size: 13px; line-height: 1.4; animation: toastIn .25s cubic-bezier(.16,1,.3,1) both;
  }
  .toast.leaving { animation: toastOut .18s ease both; }
  .toast.success { border-left-color: #16A34A; }
  .toast-icon { flex-shrink: 0; font-size: 15px; line-height: 1.2; }
  .toast-msg { flex: 1; word-break: break-word; }
  .toast-close {
    flex-shrink: 0; background: none; border: none; color: var(--muted); font-size: 16px;
    line-height: 1; cursor: pointer; padding: 0; font: inherit;
  }
  @keyframes toastIn { from { opacity: 0; transform: translateY(-8px) scale(.96); } to { opacity: 1; transform: none; } }
  @keyframes toastOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-8px) scale(.96); } }

  /* Top-right: language dropdown + theme toggle. */
  #top-right { position: fixed; top: 20px; right: 20px; z-index: 50; display: flex; gap: 8px; align-items: center; }

  #theme-toggle {
    width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    padding: 0; border: 1px solid var(--border); background: var(--panel); color: var(--fg); cursor: pointer;
  }

  .dropdown { position: relative; }
  .dropdown-toggle {
    display: flex; align-items: center; gap: 6px; height: 34px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--panel); padding: 0 10px; cursor: pointer; font: inherit; font-size: 13px; color: var(--fg);
  }
  .dropdown-toggle img { width: 18px; height: 13px; display: block; border-radius: 2px; }
  .dropdown-toggle .chev { font-size: 10px; color: var(--muted); }
  .dropdown-menu {
    position: absolute; top: calc(100% + 6px); right: 0; background: var(--panel); border: 1px solid var(--border);
    border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 6px; display: none;
    flex-direction: column; gap: 2px; min-width: 160px;
  }
  .dropdown-menu.open { display: flex; }
  .dropdown-menu button {
    display: flex; align-items: center; gap: 8px; background: none; border: none; text-align: left;
    padding: 8px 10px; border-radius: 8px; font-size: 13px; cursor: pointer; font: inherit; color: var(--fg);
  }
  .dropdown-menu button img { width: 18px; height: 13px; display: block; }
  .dropdown-menu button:hover, .dropdown-menu button.active { background: rgba(127,127,127,.15); }

  /* Operation picker FAB (bottom-right) */
  #fab-wrap { position: fixed; right: 20px; bottom: 20px; z-index: 50; }
  #fab {
    width: 56px; height: 56px; border-radius: 50%; background: var(--cosmos-button-bg); color: var(--cosmos-button-fg); border: none;
    font-size: 20px; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.18);
  }
  .fab-menu {
    position: absolute; bottom: 68px; right: 0; background: var(--panel); border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 6px; display: none; flex-direction: column; gap: 2px; min-width: 200px;
  }
  .fab-menu.open { display: flex; }
  .fab-menu .menu-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; padding: 6px 10px 2px; }
  .fab-menu button { background: none; border: none; text-align: left; padding: 10px 12px; border-radius: 8px; font-size: 13px; cursor: pointer; font: inherit; color: var(--fg); }
  .fab-menu button:hover, .fab-menu button.current { background: rgba(127,127,127,.15); }
  .menu-divider { height: 1px; background: var(--border); margin: 6px 4px; }

  /* Animated transitions between steps/results */
  @keyframes viewEnter { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
  @keyframes viewLeave { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-8px) scale(.98); } }
  #view > *, #actions > * { animation: viewEnter .3s cubic-bezier(.16,1,.3,1) both; }
  #view > *.leaving, #actions > *.leaving { animation: viewLeave .15s ease both !important; }
</style>
</head>
<body>
<div id="toast-stack" aria-live="polite"></div>
<div id="top-right">
  <div class="dropdown" id="lang-switch">
    <button class="dropdown-toggle" id="langToggle" onclick="toggleLangMenu()" aria-haspopup="true" aria-label="Language">
      <img id="langFlag" src="/assets/flag/us.svg" alt="" />
      <span id="langName">English</span>
      <span class="chev">⌄</span>
    </button>
    <div class="dropdown-menu" id="langMenu">
      <button class="active" data-lang="en" onclick="setLang('en')"><img src="/assets/flag/us.svg" alt="" /><span>English</span></button>
      <button data-lang="es" onclick="setLang('es')"><img src="/assets/flag/ar.svg" alt="" /><span>Español</span></button>
      <button data-lang="pt" onclick="setLang('pt')"><img src="/assets/flag/br.svg" alt="" /><span>Português</span></button>
    </div>
  </div>
  <button id="theme-toggle" onclick="toggleTheme()" aria-label="Toggle theme"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path></svg></button>
</div>
<main>
  <div id="view">${await renderStep("buy", "provider", { provider: null, currency: null, method: null, amount: null }, "en", "simulated")}</div>
  <div id="actions"></div>
</main>
<div id="fab-wrap">
  <div id="fab-menu" class="fab-menu"></div>
  <button id="fab" onclick="toggleFab()" aria-label="Choose operation">☰</button>
</div>
<script>
  var STEPS = ${JSON.stringify(STEPS)};
  var STR_DICT = ${JSON.stringify(STRINGS)};
  var lang = 'en';
  var mode = 'simulated'; // fixed — which network/credentials a provider talks to is decided at provider construction, not toggled here
  var op = 'buy';
  var uiMode = 'wizard';
  var stepIdx = 0;
  var state = { provider: null, currency: null, method: null, amount: null };
  var orderId = null;
  // 'buy' | 'sell' | null — which kind of order (if any) is currently pending
  // completion, i.e. showing a ReceivePayment view and being polled/confirmable.
  var pendingKind = null;
  // Confirmation mode for a pending order: false = "Real" (only the 5s poll,
  // genuinely waiting — no button), true = "Test" (poll PLUS a manual
  // mark-as-complete control). See the file's top docstring.
  var devMode = false;
  var pollTimer = null;
  var PROVIDER_META = {};
  ${INITIAL_PROVIDERS}.forEach(function (p) { PROVIDER_META[p.name] = p; });

  function STR(key) { return (STR_DICT[lang] && STR_DICT[lang][key]) || key; }
  function methodsFor(provider, currency) {
    if (provider && provider.indexOf('etherfuse') === 0) return ['link'];
    return currency === 'BRL' ? ['qr', 'link'] : ['link'];
  }
  function currenciesFor(provider) {
    var meta = PROVIDER_META[provider];
    return meta ? meta.currencies : ['ARS', 'BRL', 'MXN'];
  }

  function showToast(message, type) {
    var stack = document.getElementById('toast-stack');
    if (!stack || !message) return;
    var el = document.createElement('div');
    el.className = 'toast' + (type === 'success' ? ' success' : '');
    el.setAttribute('role', 'alert');
    el.innerHTML = '<span class="toast-icon">' + (type === 'success' ? '✓' : '⚠') + '</span><span class="toast-msg"></span><button class="toast-close" aria-label="Dismiss">×</button>';
    el.querySelector('.toast-msg').textContent = message;
    var remove = function () {
      if (!el.parentNode) return;
      el.classList.add('leaving');
      setTimeout(function () { el.remove(); }, 180);
    };
    el.querySelector('.toast-close').onclick = remove;
    var timer = setTimeout(remove, 5000);
    el.addEventListener('mouseenter', function () { clearTimeout(timer); });
    stack.appendChild(el);
  }

  // Disables the button and swaps its label for a spinner while a request is in flight
  // (prevents duplicate submits, gives feedback). Pass overrideLabel to leave it showing
  // different text once loading ends (e.g. "Check status" after a still-pending poll)
  // instead of restoring the original label.
  function setButtonLoading(btn, isLoading, overrideLabel) {
    if (!btn) return;
    if (isLoading) {
      if (btn.dataset.label === undefined) btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>';
    } else {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.innerHTML = overrideLabel !== undefined ? overrideLabel : btn.dataset.label !== undefined ? btn.dataset.label : btn.innerHTML;
      delete btn.dataset.label;
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(checkStatus, 5000);
  }

  /** "Real" confirmation mode: a pure status read, no side effects — mirrors a real integration's webhook handler landing the order as completed. */
  async function checkStatus() {
    if (!orderId) { stopPolling(); return; }
    try {
      var res = await fetch('/api/status', { method: 'POST', body: JSON.stringify({ orderId: orderId, mode: mode }) });
      var data = await res.json();
      if (data.error || !data.done) return;
      stopPolling();
      pendingKind = null;
      if (data.failed) {
        showToast(STR('genericError'), 'error');
        swapView('actions', '');
        return;
      }
      swapView('view', data.resultHtml);
      swapView('actions', '');
    } catch (err) {
      // Silent — network hiccup, the next 5s tick retries.
    }
  }

  /** Renders (or clears) the "Test" mode manual mark-as-complete control for the current pending order — called after creating one and whenever the mode toggles while one is outstanding. */
  function renderPendingActions() {
    if (!pendingKind || !devMode) {
      swapView('actions', '');
      return;
    }
    var label = pendingKind === 'sell' ? STR('markAsReceived') : STR('markAsPaid');
    var fn = pendingKind === 'sell' ? 'confirmSell()' : 'confirmBuy()';
    swapView('actions', '<div id="confirmBar"><button onclick="' + fn + '">' + label + '</button></div>');
  }

  function setDevMode(next) {
    devMode = next;
    document.getElementById('fab-menu').classList.remove('open');
    renderPendingActions();
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
    try {
      var res = await fetch('/api/step?' + qs.toString());
      var data = await res.json();
      PROVIDER_META = {};
      (data.providers || []).forEach(function (p) { PROVIDER_META[p.name] = p; });
      if (state.provider && data.providers && !data.providers.some(function (p) { return p.name === state.provider; })) {
        state.provider = null;
      }
      swapView('view', data.html);
    } catch (err) {
      showToast(STR('genericError'), 'error');
    }
  }

  var quoteDebounce = null;
  var lastEdited = 'fiat';

  function scheduleQuote(field) {
    lastEdited = field;
    clearTimeout(quoteDebounce);
    quoteDebounce = setTimeout(fetchQuotePreview, 350);
  }

  async function fetchQuotePreview() {
    var payInput = document.getElementById('payAmount');
    var receiveInput = document.getElementById('receiveAmount');
    if (!payInput || !receiveInput) return;
    var qs = new URLSearchParams({ currency: state.currency || 'ARS', mode: mode });
    if (lastEdited === 'fiat') qs.set('amount', payInput.value || '0');
    else qs.set('cryptoAmount', receiveInput.value || '0');
    try {
      var res = await fetch('/api/quote-preview?' + qs.toString());
      var data = await res.json();
      if (data.error || !data.quote) return;
      if (lastEdited === 'fiat') receiveInput.value = data.quote.cryptoAmount;
      else payInput.value = data.quote.fiatAmount;
      state.amount = Number(payInput.value);
      var note = document.getElementById('rateNote');
      if (note) note.textContent = STR('rateNote') + ' ' + data.quote.effectiveRate.toFixed(4) + ' ' + (state.currency || 'ARS');
    } catch (err) {
      // Silent — this is a debounced live preview on every keystroke; a stale/failed
      // tick isn't worth interrupting typing with a toast, the next keystroke retries.
    }
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

  var STEP_FIELDS = ['provider', 'currency', 'method', 'amount'];

  function goBack() {
    if (stepIdx === 0) return;
    stepIdx--;
    // Unwind every step that would've been auto-skipped going forward (single
    // currency / single method), so we land exactly where the forward flow
    // branched instead of on a view that was never actually shown.
    while (stepIdx > 0) {
      var name = STEPS[op][stepIdx];
      if (name === 'currency' && currenciesFor(state.provider).length === 1) { stepIdx--; continue; }
      if (name === 'method' && methodsFor(state.provider, state.currency).length === 1) { stepIdx--; continue; }
      break;
    }
    // The step we land on (and everything after it) is being re-chosen — clear
    // it so it doesn't render as still-selected.
    var landingIdx = STEP_FIELDS.indexOf(STEPS[op][stepIdx]);
    STEP_FIELDS.slice(landingIdx).forEach(function (f) { state[f] = null; });
    fetchStep();
  }

  async function submitStep() {
    if (op === 'buy') {
      var payInput = document.getElementById('payAmount');
      state.amount = payInput ? Number(payInput.value) : state.amount;
    } else {
      var amountInput = document.getElementById('amountInput');
      state.amount = amountInput ? Number(amountInput.value) : null;
    }
    var btn = document.querySelector('#view button:not(.back)');
    if (btn && btn.disabled) return;
    setButtonLoading(btn, true);
    var endpoint = op === 'buy' ? 'checkout' : op === 'sell' ? 'sell' : 'quote';
    try {
      var res = await fetch('/api/' + endpoint, {
        method: 'POST',
        body: JSON.stringify({ provider: state.provider, currency: state.currency, method: state.method, amount: state.amount, lang: lang, mode: mode }),
      });
      var data = await res.json();
      if (data.error) {
        setButtonLoading(btn, false);
        showToast(data.error, 'error');
        return;
      }
      uiMode = 'result';
      orderId = data.orderId || null;
      pendingKind = orderId && (op === 'buy' || op === 'sell') ? op : null;
      swapView('view', data.resultHtml);
      renderPendingActions();
      if (pendingKind) startPolling();
    } catch (err) {
      setButtonLoading(btn, false);
      showToast(STR('genericError'), 'error');
    }
  }

  /** "Test" mode's manual mark-as-complete control — forces the payment/crypto-received simulation immediately instead of waiting on the 5s poll. */
  async function pollConfirm(endpoint) {
    var btn = document.querySelector('#confirmBar button');
    if (btn && btn.disabled) return;
    setButtonLoading(btn, true);
    try {
      var res = await fetch('/api/' + endpoint, { method: 'POST', body: JSON.stringify({ orderId: orderId, lang: lang, mode: mode }) });
      var data = await res.json();
      var note = document.getElementById('pending-note');
      if (note) note.remove();
      if (data.error) {
        setButtonLoading(btn, false);
        showToast(data.error, 'error');
        return;
      }
      if (data.pending) {
        setButtonLoading(btn, false, STR('checkStatus'));
        var p = document.createElement('p');
        p.id = 'pending-note';
        p.textContent = STR('stillPending');
        document.getElementById('actions').appendChild(p);
        return;
      }
      stopPolling();
      pendingKind = null;
      swapView('view', data.resultHtml);
      swapView('actions', '');
    } catch (err) {
      setButtonLoading(btn, false);
      showToast(STR('genericError'), 'error');
    }
  }
  function confirmBuy() { pollConfirm('confirm'); }
  function confirmSell() { pollConfirm('sellConfirm'); }

  // Argentina's flag stands in for Spanish — this demo's Spanish-speaking market is LatAm, not Spain.
  var LANG_FLAG = { en: 'us', es: 'ar', pt: 'br' };
  var LANG_NAME = { en: 'English', es: 'Español', pt: 'Português' };

  function setLang(l) {
    lang = l;
    document.getElementById('langFlag').src = '/assets/flag/' + LANG_FLAG[l] + '.svg';
    document.getElementById('langName').textContent = LANG_NAME[l];
    document.querySelectorAll('#langMenu button').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-lang') === l);
    });
    document.getElementById('langMenu').classList.remove('open');
    if (uiMode === 'wizard') fetchStep();
  }

  function toggleLangMenu() {
    document.getElementById('langMenu').classList.toggle('open');
  }

  var SUN_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path></svg>';
  var MOON_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';

  function toggleTheme() {
    var html = document.documentElement;
    var next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    document.getElementById('theme-toggle').innerHTML = next === 'dark' ? MOON_ICON : SUN_ICON;
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
      '<button class="' + (op === 'quote' ? 'current' : '') + '" onclick="chooseOp(\\'quote\\')">' + STR('opQuote') + '</button>' +
      '<div class="menu-divider"></div>' +
      '<div class="menu-label">' + STR('confirmationMode') + '</div>' +
      '<button class="' + (!devMode ? 'current' : '') + '" onclick="setDevMode(false)">' + STR('modeReal') + '</button>' +
      '<button class="' + (devMode ? 'current' : '') + '" onclick="setDevMode(true)">' + STR('modeDev') + '</button>';
    menu.classList.add('open');
  }

  function chooseOp(next) {
    op = next;
    stepIdx = 0;
    uiMode = 'wizard';
    orderId = null;
    pendingKind = null;
    stopPolling();
    state = { provider: null, currency: null, method: null, amount: null };
    document.getElementById('actions').innerHTML = '';
    document.getElementById('fab-menu').classList.remove('open');
    fetchStep();
  }

  document.addEventListener('click', function (e) {
    var fabWrap = document.getElementById('fab-wrap');
    if (!fabWrap.contains(e.target)) document.getElementById('fab-menu').classList.remove('open');
    var langWrap = document.getElementById('lang-switch');
    if (!langWrap.contains(e.target)) document.getElementById('langMenu').classList.remove('open');
  });
</script>
</body>
</html>`;
