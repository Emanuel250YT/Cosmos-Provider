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
 *   npm run demo:ui         (test mode  → loads .env.test,       MP sandbox forced on)
 *   npm run demo:ui:prod    (production → loads .env.production, MP sandbox from MP_SANDBOX)
 *   → open http://localhost:4000 (test) or :4001 (production) — see PORT below;
 *     override either with a PORT env var
 *
 * Three providers are registered by default — `EtherfuseProvider`,
 * `MercadoPagoProvider` (BR) and `MercadoPagoProvider` (AR), each with a
 * `logoUrl` — reusing `ramp.providers` for the picker means adding a fourth
 * is the only change needed anywhere.
 *
 * WHICH .env FILE, AND SANDBOX VS. REAL CHARGES — both come from ONE choice,
 * `--env=test` (default, `npm run demo:ui`) or `--env=production`
 * (`npm run demo:ui:prod`), read below before anything else runs:
 *   - `--env=test` loads `.env.test` — safe by construction: Mercado Pago is
 *     forced `sandbox: true` (see `buildMercadoPago`) no matter what's in
 *     that file, so this mode can NEVER place a real, chargeable preference.
 *   - `--env=production` loads `.env.production` and reads `MP_SANDBOX` from
 *     it to decide `sandbox: true/false` — set `MP_SANDBOX="false"` there to
 *     let this demo place REAL, genuinely chargeable Mercado Pago
 *     preferences with your real account. Documented in
 *     `.env.production.example`. Know what you're testing against.
 * Each Mercado Pago account uses its real `MP_*_ACCESS_TOKEN` when the
 * loaded file sets one. What happens when it DOESN'T also depends on `--env`
 * (`REQUIRE_REAL_CREDENTIALS` below):
 *   - `--env=test` falls back to the local, in-memory simulator
 *     (`examples/helpers/mock-mercadopago`, safe/deterministic/no external
 *     calls), so the whole UI stays walkable with an empty `.env.test`.
 *     Etherfuse is registered keyless too and talks to its real sandbox API.
 *   - `--env=production` registers NOTHING it has no credentials for: an
 *     uncredentialed provider is dropped outright instead of being silently
 *     mocked, so it never reaches the picker (or `/api/*`, or a checkout
 *     someone could reach by posting its name directly) and a production run
 *     can't hand anyone a faked payment. Etherfuse needs `ETHERFUSE_API_KEY`
 *     on the same terms — it stays `environment: "sandbox"` either way, this
 *     demo has no production mode for it. Startup aborts if that leaves zero
 *     providers.
 * `mockBackedProviders` tracks which provider names are on the local
 * simulator, so `confirmOrder` knows whether it's safe to fake a payment
 * (mock) or must genuinely check status (sandbox or real). It's always empty
 * in production mode.
 *
 * CONFIRMING AN ORDER — two paths, and only one of them is honest:
 *   - "Real" mode (default, no button): the page polls `/api/status` every
 *     5s. That endpoint verifies — it reads the actual charge from the
 *     provider and completes the order only if someone genuinely paid. This
 *     is what a production integration relies on (its webhook handler lands
 *     the same state; the poll is this demo's backstop for when the tunnel
 *     carrying those webhooks is down).
 *   - "Test" mode (FAB): adds a manual control calling `/api/confirm`, which
 *     OVERRIDES rather than checks. Against a real Mercado Pago account it
 *     skips Mercado Pago outright and releases the crypto with no verified
 *     fiat payment — the only way to exercise the settlement leg without
 *     literally buying from yourself. On mainnet that spends real USDC out of
 *     the distributor, so treat the endpoint as privileged: it is
 *     unauthenticated, like everything else here, and `PUBLIC_BASE_URL`
 *     exposes it to whoever can reach the tunnel.
 *
 * Two things are deliberately real regardless of mock/live — see
 * examples/mercadopago/settlement-demo.ts for the full rationale:
 * - The rate: `CoinGeckoOracle`, no fixed/mocked number.
 * - The release: a REAL Stellar transaction for a proper asset (testnet by
 *   default, mainnet under STELLAR_NETWORK="public"), EXCEPT for Etherfuse
 *   orders, which release their own crypto internally (this demo skips its
 *   own settlement for those — see `settlementFn`).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { config as loadEnv } from "dotenv";
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

// ---------------------------------------------------------------------------
// --env=test (default) | --env=production — picks which .env file this demo
// loads, BEFORE anything below reads process.env. See this file's top
// docstring and .env.test.example/.env.production.example for what each one
// means (in particular: whether Mercado Pago can place real charges).
// ---------------------------------------------------------------------------
const envFlag = process.argv.find((arg) => arg.startsWith("--env="));
const DEMO_ENV = envFlag ? envFlag.slice("--env=".length) : "test";
if (DEMO_ENV !== "test" && DEMO_ENV !== "production") {
  console.error(`Unknown --env=${DEMO_ENV} — expected "test" or "production".`);
  process.exit(1);
}
const ENV_FILE = `.env.${DEMO_ENV}`;
const envResult = loadEnv({ path: ENV_FILE });
if (envResult.error) {
  console.warn(`⚠ Could not load ${ENV_FILE} (${(envResult.error as Error).message}) — continuing with whatever's already in the environment. Copy .env.${DEMO_ENV}.example to get started.`);
} else {
  console.log(`Loaded ${ENV_FILE} (--env=${DEMO_ENV})`);
}
/** Whether Mercado Pago runs in sandbox mode — ALWAYS true in test mode, regardless of `.env.test`'s content; only production mode reads `MP_SANDBOX` (default true — must be explicitly set to "false" to place real charges). See buildMercadoPago below. */
const MP_SANDBOX = DEMO_ENV === "test" ? true : (process.env.MP_SANDBOX ?? "true") !== "false";

/**
 * Production refuses to register a provider it has no API key for, instead
 * of quietly substituting the local simulator the way test mode does — see
 * the `--env` section of this file's top docstring. Keeps the picker honest:
 * whatever is listed in production is backed by a real account.
 */
const REQUIRE_REAL_CREDENTIALS = DEMO_ENV === "production";

/** Provider names left unregistered for lack of credentials, for the startup log. */
const skippedProviders: string[] = [];

// Production defaults to a different port than test so both can run at the
// same time (e.g. comparing sandbox vs. real behavior side by side) — override
// either with a PORT env var (also settable from the loaded .env file itself).
const PORT = process.env.PORT ? Number(process.env.PORT) : DEMO_ENV === "production" ? 4001 : 4000;
const WEBHOOK_SECRET = "demo-mp-secret";

type Op = "buy" | "sell" | "quote";
type Method = "qr" | "link";
type Currency = "ARS" | "BRL" | "MXN";
type Lang = "en" | "es" | "pt";
interface WizardState {
  provider: string | null;
  currency: Currency | null;
  method: Method | null;
  wallet: string | null;
  amount: number | null;
}

/** Sensible unprompted starting points (~10 USD) — not enforced limits, just a reasonable prefill per currency. */
const DEFAULT_FIAT_AMOUNT: Record<Currency, number> = { ARS: 2000, BRL: 20, MXN: 300 };
const DEFAULT_CRYPTO_AMOUNT = 10;

const parseCurrency = (v: unknown): Currency => (v === "ARS" ? "ARS" : v === "MXN" ? "MXN" : "BRL");
const toFiatCurrency = (c: Currency): FiatCurrency => (c === "ARS" ? FiatCurrency.ARS : c === "MXN" ? FiatCurrency.MXN : FiatCurrency.BRL);

const STEPS: Record<Op, string[]> = {
  buy: ["provider", "currency", "method", "wallet", "amount"],
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
    stepWallet: "Wallet",
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
    walletLabel: "Destination wallet",
    connectWallet: "Connect wallet",
    changeWallet: "Change wallet",
    walletNotConnected: "No wallet connected",
    walletConnectError: "Couldn't connect your wallet. Please try again.",
    useDemoWallet: "No wallet installed? Use a test wallet",
    orLabel: "OR",
    manualWalletLabel: "Paste a wallet address",
    walletPlaceholder: "G... wallet address",
    useThisAddress: "Use this address",
    walletInvalid: "That doesn't look like a valid Stellar address.",
    walletHint: "Where should we send the USDC? Connect your own wallet, or paste any Stellar address — handy when you're sending to someone else, like a remittance.",
    walletRequired: "Connect or enter a wallet to continue.",
    amountFiat: "Amount",
    amountCrypto: "Amount (USDC)",
    checkStatus: "Check status",
    stillPending: "Still pending — try again in a moment.",
    genericError: "Something went wrong. Please try again.",
    waitingCrypto: "Waiting for your USDC",
    step: "Step",
    of: "of",
    chooseOperation: "Choose an operation",
    confirmationMode: "Confirmation mode",
    modeReal: "Real — wait for webhook",
    modeDev: "Test — mark as paid manually",
    markAsPaid: "Force release (skips Mercado Pago)",
    markAsReceived: "Mark as received (simulate)",
    youPay: "You pay",
    youReceive: "You receive",
    rateNote: "1 USDC ≈",
    trustlineTitle: "Enable USDC trustline",
    trustlineBodyKit: "Your wallet doesn't have a trustline for the USDC this demo pays out. Approve one now (a single Stellar operation) — without it the USDC can't be delivered, so checkout won't let you pay.",
    trustlineBodyManual: "This address doesn't have a trustline for the USDC this demo pays out, and we don't hold its key, so we can't open one for it. Open the trustline from the wallet that owns this address, or connect that wallet here instead. Until then checkout is blocked — paying without it would take your money and deliver nothing.",
    trustlineEnable: "Enable trustline",
    trustlineBack: "Use a different wallet",
    trustlineCheckFailed: "Couldn't verify the trustline on this wallet. Try again — checkout stays blocked until we can confirm the USDC can actually be delivered.",
    trustlineChecking: "Checking your wallet…",
    trustlineSuccess: "Trustline enabled — continuing…",
    trustlineError: "Couldn't enable the trustline. You can try again or continue anyway.",
    copiedToClipboard: "Copied to clipboard",
  },
  es: {
    opBuy: "Comprar USDC",
    opSell: "Vender USDC",
    opQuote: "Obtener cotización",
    stepProvider: "Proveedor",
    stepCurrency: "Divisa",
    stepMethod: "Método",
    stepWallet: "Wallet",
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
    walletLabel: "Wallet de destino",
    connectWallet: "Conectar wallet",
    changeWallet: "Cambiar wallet",
    walletNotConnected: "Ninguna wallet conectada",
    walletConnectError: "No pudimos conectar tu wallet. Probá de nuevo.",
    useDemoWallet: "¿No tenés wallet instalada? Usar una de prueba",
    orLabel: "O",
    manualWalletLabel: "Pegá una dirección de wallet",
    walletPlaceholder: "Dirección de wallet (G...)",
    useThisAddress: "Usar esta dirección",
    walletInvalid: "Esa dirección de Stellar no parece válida.",
    walletHint: "¿A dónde enviamos los USDC? Conectá tu propia wallet, o pegá cualquier dirección de Stellar — útil si estás enviando una remesa a otra persona.",
    walletRequired: "Conectá o ingresá una wallet para continuar.",
    amountFiat: "Monto",
    amountCrypto: "Monto (USDC)",
    checkStatus: "Verificar estado",
    stillPending: "Todavía pendiente — probá de nuevo en un momento.",
    genericError: "Algo salió mal. Probá de nuevo.",
    waitingCrypto: "Esperando tu USDC",
    step: "Paso",
    of: "de",
    chooseOperation: "Elegí una operación",
    confirmationMode: "Modo de confirmación",
    modeReal: "Real — esperar webhook",
    modeDev: "Prueba — marcar como pagado a mano",
    markAsPaid: "Forzar liberación (omite Mercado Pago)",
    markAsReceived: "Marcar como recibido (simular)",
    youPay: "Pagás",
    youReceive: "Recibís",
    rateNote: "1 USDC ≈",
    trustlineTitle: "Habilitar trustline de USDC",
    trustlineBodyKit: "Tu wallet todavía no tiene una trustline para el USDC que entrega este demo. Aprobala ahora (una única operación de Stellar) — sin ella no podemos enviarte el USDC, así que el checkout no te va a dejar pagar.",
    trustlineBodyManual: "Esta dirección todavía no tiene una trustline para el USDC que entrega este demo, y como no tenemos su clave no podemos abrirla por vos. Abrila desde la wallet dueña de esa dirección, o conectá esa wallet acá. Hasta entonces el checkout queda bloqueado — pagar sin la trustline sería perder la plata sin recibir nada.",
    trustlineEnable: "Habilitar trustline",
    trustlineBack: "Usar otra wallet",
    trustlineCheckFailed: "No pudimos verificar la trustline de esta wallet. Probá de nuevo — el checkout queda bloqueado hasta poder confirmar que el USDC se puede entregar.",
    trustlineChecking: "Verificando tu wallet…",
    trustlineSuccess: "Trustline habilitada — continuando…",
    trustlineError: "No pudimos habilitar la trustline. Podés reintentar o continuar igual.",
    copiedToClipboard: "Copiado al portapapeles",
  },
  pt: {
    opBuy: "Comprar USDC",
    opSell: "Vender USDC",
    opQuote: "Obter cotação",
    stepProvider: "Provedor",
    stepCurrency: "Moeda",
    stepMethod: "Método",
    stepWallet: "Wallet",
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
    walletLabel: "Wallet de destino",
    connectWallet: "Conectar wallet",
    changeWallet: "Trocar wallet",
    walletNotConnected: "Nenhuma wallet conectada",
    walletConnectError: "Não conseguimos conectar sua wallet. Tente novamente.",
    useDemoWallet: "Não tem wallet instalada? Usar uma de teste",
    orLabel: "OU",
    manualWalletLabel: "Cole um endereço de wallet",
    walletPlaceholder: "Endereço da wallet (G...)",
    useThisAddress: "Usar este endereço",
    walletInvalid: "Esse endereço Stellar não parece válido.",
    walletHint: "Para onde enviamos os USDC? Conecte sua própria wallet, ou cole qualquer endereço Stellar — útil se você estiver enviando uma remessa para outra pessoa.",
    walletRequired: "Conecte ou informe uma wallet para continuar.",
    amountFiat: "Valor",
    amountCrypto: "Valor (USDC)",
    checkStatus: "Verificar status",
    stillPending: "Ainda pendente — tente novamente em instantes.",
    genericError: "Algo deu errado. Tente novamente.",
    waitingCrypto: "Aguardando seu USDC",
    step: "Etapa",
    of: "de",
    chooseOperation: "Escolha uma operação",
    confirmationMode: "Modo de confirmação",
    modeReal: "Real — aguardar webhook",
    modeDev: "Teste — marcar como pago manualmente",
    markAsPaid: "Forçar liberação (ignora o Mercado Pago)",
    markAsReceived: "Marcar como recebido (simular)",
    youPay: "Você paga",
    youReceive: "Você recebe",
    rateNote: "1 USDC ≈",
    trustlineTitle: "Habilitar trustline de USDC",
    trustlineBodyKit: "Sua wallet ainda não tem uma trustline para o USDC que este demo entrega. Aprove agora (uma única operação Stellar) — sem ela não conseguimos enviar o USDC, então o checkout não vai deixar você pagar.",
    trustlineBodyManual: "Este endereço ainda não tem uma trustline para o USDC que este demo entrega, e como não temos a chave dele não podemos abri-la por você. Abra a trustline pela wallet dona desse endereço, ou conecte essa wallet aqui. Até lá o checkout fica bloqueado — pagar sem ela seria perder o dinheiro sem receber nada.",
    trustlineEnable: "Habilitar trustline",
    trustlineBack: "Usar outra wallet",
    trustlineCheckFailed: "Não conseguimos verificar a trustline desta wallet. Tente de novo — o checkout fica bloqueado até confirmarmos que o USDC pode ser entregue.",
    trustlineChecking: "Verificando sua wallet…",
    trustlineSuccess: "Trustline habilitada — continuando…",
    trustlineError: "Não conseguimos habilitar a trustline. Você pode tentar de novo ou continuar mesmo assim.",
    copiedToClipboard: "Copiado para a área de transferência",
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
const shortenAddress = (address: string): string => (address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);
const isValidStellarAddress = (value: string): boolean => /^G[A-Z2-7]{55}$/.test(value);
/** This demo's wallet address round-trips through the URL query string (`/api/step?wallet=...`) and back into server-rendered HTML — escape it wherever it's echoed, now that the server is reachable from the public internet. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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
// Stellar Wallets Kit bundle: `wallet-kit-client.ts` is browser-only code
// (it touches `window` and wallet browser extensions), so it can't just be
// `import`ed here like the rest of this file — it's bundled on demand with
// esbuild (IIFE, no external deps left unresolved) and served as a plain
// <script> from /assets/wallet-kit.js. Built once and cached; the source
// only changes between server restarts.
// ---------------------------------------------------------------------------

let walletKitBundle: Promise<string> | null = null;
function getWalletKitBundle(): Promise<string> {
  if (!walletKitBundle) {
    walletKitBundle = esbuild
      .build({
        entryPoints: [path.join(HERE, "wallet-kit-client.ts")],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2020",
        write: false,
        logLevel: "silent",
      })
      .then((result) => result.outputFiles[0]!.text);
  }
  return walletKitBundle;
}

// ---------------------------------------------------------------------------
// Providers, oracle, settlement — Simulated and Live variants.
// ---------------------------------------------------------------------------

/**
 * WHICH STELLAR NETWORK THE CRYPTO LEG SETTLES ON — `STELLAR_NETWORK`,
 * "testnet" (default) or "public". The two modes are genuinely different
 * arrangements, not one flag:
 *
 *   testnet — this process ISSUES the asset it pays out. An issuing account
 *     can send its own asset with no balance and no trustline of its own, so
 *     "funding the treasury" is just Friendbot-funding one account for fees.
 *     The "USDC" a buyer receives is this demo's own token, worth nothing.
 *
 *   public — nobody can issue Circle's USDC, so payouts come from a
 *     DISTRIBUTOR account you own that already holds a real USDC balance
 *     (`STELLAR_DISTRIBUTOR_SECRET`), paying out the asset issued by
 *     `STELLAR_USDC_ISSUER` (Circle's mainnet issuer by default). Every
 *     release spends real USDC. No Friendbot exists here: the distributor
 *     must be funded with XLM for fees, and the buyer's wallet must already
 *     trust the asset — this demo cannot open a trustline on their behalf.
 */
const STELLAR_NETWORK = (process.env.STELLAR_NETWORK?.trim() || "testnet").toLowerCase();
if (STELLAR_NETWORK !== "testnet" && STELLAR_NETWORK !== "public") {
  console.error(`✘ Unknown STELLAR_NETWORK="${STELLAR_NETWORK}" in .env.${DEMO_ENV} — expected "testnet" or "public".`);
  process.exit(1);
}
const IS_MAINNET = STELLAR_NETWORK === "public";
const NETWORK_PASSPHRASE = IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET;
const HORIZON_URL = process.env.STELLAR_HORIZON_URL?.trim() || (IS_MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org");
/** stellar.expert path segment for this network — used by `stellarExpertTxUrl`. */
const EXPLORER_NETWORK = IS_MAINNET ? "public" : "testnet";
/** Circle's USDC on Stellar mainnet. Only consulted when IS_MAINNET. */
const CIRCLE_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const stellarServer = new Horizon.Server(HORIZON_URL);
const mp = createMockMercadoPago({ webhookSecret: WEBHOOK_SECRET });

/** Parse a Stellar secret from the environment, failing loudly rather than silently degrading. */
function requireKeypair(envName: string, secret: string | undefined, hint: string): Keypair {
  if (!secret) {
    console.error(`✘ ${envName} is required in .env.${DEMO_ENV} when STELLAR_NETWORK="public".\n  ${hint}`);
    process.exit(1);
  }
  try {
    return Keypair.fromSecret(secret);
  } catch (error) {
    // Keypair.fromSecret is strict (StrKey format + checksum) and throws on
    // anything else — a public key pasted by mistake, a non-Stellar string,
    // truncated copy/paste, etc. Fail loudly with a clear, actionable
    // message here instead of letting that exception bubble up as an opaque
    // Stellar SDK stack trace (or, worse, silently falling back to a random
    // key — that would look like it "took" when it didn't).
    console.error(
      `✘ ${envName} in .env.${DEMO_ENV} is not a valid Stellar secret key (${String((error as Error).message ?? error)}).\n` +
        `  It must start with "S" and be 56 characters.`,
    );
    process.exit(1);
  }
}

// Testnet only. Doubles as the "treasury": the account that issues an asset
// can send it directly, with no trustline of its own — issuing IS just a
// payment.
//
// Defaults to a fresh, throwaway keypair every server start (simplest for a
// one-off demo run) — but that means every restart mints a DIFFERENT USDC
// (same code, different issuer = a different Stellar asset), so anything
// released by a previous run becomes worthless, and any pre-funded balance
// on that old issuer is gone. Set STELLAR_ISSUER_SECRET in `.env` to reuse
// the SAME issuer account across restarts instead — one real testnet secret
// key (e.g. from `Keypair.random().secret()` or Stellar Laboratory's
// "Generate keypair"), funded once. Never a mainnet secret.
function loadIssuerKeypair(): Keypair {
  const secret = process.env.STELLAR_ISSUER_SECRET?.trim();
  if (!secret) return Keypair.random();
  return requireKeypair("STELLAR_ISSUER_SECRET", secret, "");
}

/**
 * The account that SIGNS and funds every release, and the asset it pays out.
 *
 * On testnet these are the same account twice over (the issuer pays out what
 * it issues). On mainnet they're deliberately separate: `payer` is your
 * distributor, `assetIssuer` is Circle.
 */
const settlementSource = IS_MAINNET
  ? (() => {
      const payer = requireKeypair(
        "STELLAR_DISTRIBUTOR_SECRET",
        process.env.STELLAR_DISTRIBUTOR_SECRET?.trim(),
        "It's the mainnet account that holds the USDC this demo pays out (and the XLM for fees).",
      );
      const assetIssuer = process.env.STELLAR_USDC_ISSUER?.trim() || CIRCLE_USDC_ISSUER;
      return { payer, assetIssuer, selfIssued: false };
    })()
  : (() => {
      const issuerKp = loadIssuerKeypair();
      return { payer: issuerKp, assetIssuer: issuerKp.publicKey(), selfIssued: true };
    })();

/** Kept as `issuer` for continuity: the account the settlement asset is issued BY (Circle on mainnet, this demo on testnet). */
const issuer = settlementSource.payer;
const ISSUER_SOURCE = IS_MAINNET
  ? `distributor ${settlementSource.payer.publicKey()} paying out USDC issued by ${settlementSource.assetIssuer}`
  : process.env.STELLAR_ISSUER_SECRET?.trim()
    ? `from STELLAR_ISSUER_SECRET in .env.${DEMO_ENV}`
    : "random — set STELLAR_ISSUER_SECRET to reuse the same one across restarts";
// Matches CosmosRamp's default `defaults.asset` ("USDC") — neither ramp
// instance below overrides it, so every order settles in this asset.
const DEMO_ASSET_CODE = "USDC";
/** The exact asset every release pays out — what a receiving wallet must trust. */
const SETTLEMENT_ASSET = new StellarAsset(DEMO_ASSET_CODE, settlementSource.assetIssuer);
// Populated by generateDemoWallet() below — settlement needs each receiving
// wallet's own keypair to sign the trustline it opens for itself. Wallets
// connected via Stellar Wallets Kit (the primary path) are NOT in here — the
// server never holds their key — so they open their own trustline via the
// /api/trustline* actions below (see wallet-kit-client.ts's signStellarTransaction).
// Never populated on mainnet: there's no Friendbot to fund such a wallet.
const walletByAddress = new Map<string, Keypair>();
let stellarReady = false;

/**
 * Is the paying account live and able to settle?
 *
 * Re-probed on demand rather than latched at boot: Horizon is occasionally
 * slow enough to time out, and a single failed probe at startup used to leave
 * `stellarReady` false for the entire process — every settlement for the rest
 * of the run silently degrading to a fake tx id over a blip that had long
 * since cleared. Cheap to retry (one `loadAccount`), and once true it stays
 * true.
 *
 * On mainnet an unfunded/nonexistent distributor is fatal rather than
 * Friendbot-able, so this reports false and checkout refuses to take money.
 */
async function ensureStellarReady(): Promise<boolean> {
  if (stellarReady) return true;
  try {
    const account = await stellarServer.loadAccount(settlementSource.payer.publicKey());
    stellarReady = true;
    if (IS_MAINNET) {
      const held = account.balances.find(
        (b) => "asset_code" in b && b.asset_code === DEMO_ASSET_CODE && "asset_issuer" in b && b.asset_issuer === settlementSource.assetIssuer,
      );
      const balance = held && "balance" in held ? held.balance : null;
      if (balance === null) {
        console.warn(`⚠ MAINNET distributor ${settlementSource.payer.publicKey()} has NO trustline for ${DEMO_ASSET_CODE} (${settlementSource.assetIssuer}) — it holds none of the asset it's meant to pay out.`);
      } else {
        console.log(`✔ MAINNET distributor ready: ${settlementSource.payer.publicKey()} — ${balance} ${DEMO_ASSET_CODE} available`);
      }
    } else {
      console.log(`✔ Demo USDC issuer already funded: ${settlementSource.payer.publicKey()} (${ISSUER_SOURCE})`);
    }
    return true;
  } catch {
    // Either not funded yet, or Horizon didn't answer.
  }
  if (IS_MAINNET) {
    // No Friendbot on mainnet — this is a real account that must already exist.
    console.warn(`⚠ Could not load the mainnet distributor ${settlementSource.payer.publicKey()} (unfunded account, or Horizon unreachable).`);
    console.warn("  Checkout will be refused until it resolves — this demo won't take money it can't settle.");
    return false;
  }
  console.log(`Funding a Stellar testnet demo-USDC issuer (Friendbot)... (${ISSUER_SOURCE})`);
  try {
    await stellarServer.friendbot(settlementSource.payer.publicKey()).call();
    stellarReady = true;
    console.log(`✔ Demo USDC issuer funded: ${settlementSource.payer.publicKey()} (${ISSUER_SOURCE})`);
  } catch (error) {
    console.warn(`⚠ Could not reach Stellar testnet/Friendbot: ${String(error)}`);
    console.warn("  Checkout will be refused until it comes back — this demo won't take money it can't settle.");
  }
  return stellarReady;
}

console.log(`Stellar settlement: ${IS_MAINNET ? "⚠ MAINNET (real USDC moves)" : "testnet (self-issued demo asset)"} via ${HORIZON_URL}`);

// Real fiat charges are only allowed once the crypto leg is real too.
// `MP_SANDBOX="false"` on a testnet settlement means genuine ARS/BRL out of a
// buyer's account and a self-issued testnet token — worth nothing — back.
// That combination is refused rather than left as a footgun one env var away;
// with STELLAR_NETWORK="public" the pairing makes sense and this lets it run.
if (!MP_SANDBOX && !IS_MAINNET) {
  console.error(
    `✘ MP_SANDBOX="false" with STELLAR_NETWORK="testnet" is refused: the fiat leg would be a real, chargeable\n` +
      `  Mercado Pago preference while the crypto leg pays out this demo's own testnet token — real money in,\n` +
      `  nothing of value out.\n` +
      `  Either set MP_SANDBOX="true" (real account, no chargeable preferences), or set STELLAR_NETWORK="public"\n` +
      `  with a funded STELLAR_DISTRIBUTOR_SECRET to settle in real USDC. See .env.production.example.`,
  );
  process.exit(1);
}

await ensureStellarReady();

/**
 * A fresh, Friendbot-funded Stellar address to receive the settlement —
 * offered as an opt-in fallback ("no wallet installed?") on the wallet step
 * for people testing without a browser wallet extension. Never used unless
 * explicitly requested; the primary path is Stellar Wallets Kit.
 */
async function generateDemoWallet(): Promise<string> {
  // Mainnet has no Friendbot: a fresh keypair would be an unfunded account
  // that can't even hold a trustline, and settlement there spends real USDC.
  if (IS_MAINNET) throw new Error("Throwaway demo wallets aren't available on mainnet — connect a real wallet that already trusts USDC.");
  const kp = Keypair.random();
  if (await ensureStellarReady()) {
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
 * Whether `wallet` already has an open trustline for the demo USDC asset —
 * checked via Horizon before deciding whether settlement needs a `changeTrust`
 * op. `false` (never throws) for an account that doesn't exist on testnet
 * yet, same as "no trustline" — settlement/the trustline-open flow handle
 * funding it themselves.
 */
async function accountTrustsAsset(wallet: string, asset: StellarAsset): Promise<boolean> {
  try {
    const account = await stellarServer.loadAccount(wallet);
    return account.balances.some((b) => "asset_code" in b && "asset_issuer" in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
  } catch {
    return false;
  }
}

/**
 * Shared by both CosmosRamp instances AND called directly for Live/Etherfuse
 * confirmations (see confirmOrder below) — Etherfuse orders skip this
 * entirely (it already released its own crypto); everything else gets a
 * real Stellar testnet release, regardless of whether the fiat leg was
 * simulated or live.
 *
 * Two ways a wallet can end up trusting the demo asset by the time this
 * runs: the server holds its key (`walletByAddress` — the "use a test
 * wallet" fallback) and opens the trustline itself here in the same tx as
 * the payment; or it's a real, user-connected wallet that already opened its
 * OWN trustline via the /api/trustline* actions (see the wallet step's
 * "enable trustline" prompt) before checkout. Either way, once a trustline
 * exists this only needs the issuer's signature — Stellar payments never
 * require the receiver to sign.
 */
const settlementFn: SettlementFn = async ({ order, wallet, amount, asset }) => {
  if (order.provider.startsWith("etherfuse")) {
    console.log(`⛓ ${order.provider}: crypto already released internally by Etherfuse — skipping this demo's settlement.`);
    return { txId: `etherfuse-managed:${order.id}` };
  }
  // Whether a failed release is allowed to degrade into a fake tx id. Fine
  // for a mock-backed order (no money moved either way); NEVER for one whose
  // fiat leg was a real Mercado Pago charge — pairing real money in with a
  // `0xdemo…` id marks the order "completed" and tells the buyer they were
  // paid when nothing was sent. Throwing instead leaves the order in
  // "settling" for `ramp.retrySettlement(orderId)` once the cause is fixed.
  const realMoney = !isMockBacked(order.provider);
  if ((await ensureStellarReady()) && wallet) {
    try {
      // The asset actually being released. On testnet this demo issues it;
      // on mainnet it's Circle's USDC and `payer` merely holds a balance of
      // it. `asset` from the order is the code ("USDC" by default).
      const stellarAsset = asset === DEMO_ASSET_CODE ? SETTLEMENT_ASSET : new StellarAsset(asset, settlementSource.assetIssuer);
      const receiver = walletByAddress.get(wallet); // set only for server-generated demo wallets — we hold this key (testnet only)
      const trusts = await accountTrustsAsset(wallet, stellarAsset);
      if (!trusts && !receiver) {
        // A real, user-connected wallet with no trustline for this asset — we
        // don't hold its key, so we can't open the trustline on its behalf
        // here. `assertWalletCanReceive` rejects this at checkout, before any
        // charge exists, so reaching it means the trustline was REMOVED
        // between checkout and payment.
        const why = `${wallet} has no trustline for ${asset} (issuer ${stellarAsset.getIssuer()}) and this demo doesn't hold its key, so the release can't be made.`;
        if (realMoney) throw new Error(`${why} The fiat payment WAS collected — open the trustline, then retry the settlement for order ${order.id}.`);
        console.warn(`⚠ ${why} Falling back to a simulated tx id (mock-backed order — no real money involved).`);
      } else {
        const account = await stellarServer.loadAccount(settlementSource.payer.publicKey());
        // On mainnet the payer spends a real balance rather than issuing, so
        // check it covers this release before building anything — a failed
        // `op_underfunded` after the fiat was collected is the same stuck
        // order, just discovered later and with a worse error.
        if (!settlementSource.selfIssued) {
          const held = account.balances.find(
            (b) => "asset_code" in b && b.asset_code === stellarAsset.getCode() && "asset_issuer" in b && b.asset_issuer === stellarAsset.getIssuer(),
          );
          const available = held && "balance" in held ? Number(held.balance) : 0;
          if (!held) throw new Error(`Distributor ${settlementSource.payer.publicKey()} has no trustline for ${asset} (${stellarAsset.getIssuer()}) — it can't hold, let alone send, the asset.`);
          if (available < amount) throw new Error(`Distributor ${settlementSource.payer.publicKey()} holds ${available} ${asset} but this release needs ${amount}. Top it up, then retry the settlement for order ${order.id}.`);
        }
        const builder = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 2), networkPassphrase: NETWORK_PASSPHRASE });
        // Trustline (if it's not already open) and payment go in the SAME
        // transaction: `changeTrust` sourced from the wallet, `payment`
        // sourced from the payer, signed by both — only reachable when we
        // hold the wallet's key (the testnet demo-wallet fallback).
        if (!trusts) builder.addOperation(Operation.changeTrust({ asset: stellarAsset, source: wallet }));
        builder.addOperation(Operation.payment({ destination: wallet, asset: stellarAsset, amount: String(Math.round(amount * 1e7) / 1e7) }));
        const tx = builder.setTimeout(30).build();
        tx.sign(settlementSource.payer);
        if (!trusts) tx.sign(receiver!);
        const result = await stellarServer.submitTransaction(tx);
        console.log(
          `⛓ settlement: ${trusts ? "sent" : "opened trustline + sent"} ${amount} ${asset} (${IS_MAINNET ? "MAINNET, real USDC" : "testnet, self-issued asset"}) → ${wallet} — https://stellar.expert/explorer/${EXPLORER_NETWORK}/tx/${result.hash}`,
        );
        return { txId: result.hash };
      }
    } catch (error) {
      if (realMoney) throw error instanceof Error ? error : new Error(String(error));
      console.warn(`⚠ Stellar settlement failed, falling back to a simulated tx id: ${String(error)}`);
    }
  }
  if (realMoney) {
    throw new Error(
      `Settlement could not run for order ${order.id} (${stellarReady ? "no destination wallet" : "Stellar unreachable"}), and its fiat leg was a real ${order.provider} charge — refusing to complete it with a simulated tx id. ` +
        `Fix the cause and retry the settlement.`,
    );
  }
  console.log(`⛓ settlement (simulated): sent ${amount} ${asset} → ${wallet}`);
  return { txId: `0xdemo${Date.now()}` };
};

/**
 * stellar.expert link for a `settlementTxId`, only when it's a genuine
 * Stellar testnet transaction hash (64 hex chars, as returned by
 * `stellarServer.submitTransaction` above) — `undefined` for Etherfuse's
 * `etherfuse-managed:<id>` marker and for the `0xdemo...` id `settlementFn`
 * falls back to when Friendbot/testnet is unreachable, neither of which are
 * real on-chain transactions. Passed to `rampOrderToDetailRows` so the
 * "Settlement Tx" row only renders as a link when there's really something
 * to click through to.
 */
function stellarExpertTxUrl(txId: string): string | undefined {
  return /^[0-9a-f]{64}$/i.test(txId) ? `https://stellar.expert/explorer/${EXPLORER_NETWORK}/tx/${txId}` : undefined;
}

// Etherfuse settles both Brazil (PIX/BRL) and Mexico (SPEI/MXN), so both
// currencies show up in the picker and both build a real charge — BRL
// delivers Asset.TESOURO, MXN delivers Asset.CETES (see EtherfuseProvider's docstring).
// No mock exists for it, so without ETHERFUSE_API_KEY it can only fail at
// checkout: test mode registers it anyway (the failure is informative there),
// production drops it entirely (`REQUIRE_REAL_CREDENTIALS`) — hence nullable.
const ETHERFUSE_API_KEY = process.env.ETHERFUSE_API_KEY?.trim() ?? "";
const etherfuseProvider =
  REQUIRE_REAL_CREDENTIALS && !ETHERFUSE_API_KEY
    ? null
    : new EtherfuseProvider({
        apiKey: ETHERFUSE_API_KEY,
        environment: "sandbox",
        regions: ["BR", "MX"],
        currencies: [FiatCurrency.BRL, FiatCurrency.MXN],
        logoUrl: "/assets/logo/etherfuse.ico",
      });
if (!etherfuseProvider) skippedProviders.push("etherfuse (no ETHERFUSE_API_KEY)");

const oracle = () => new CoinGeckoOracle({ apiKey: process.env.COINGECKO_API_KEY });

/**
 * Base URL Mercado Pago's REAL webhooks get pointed at (`notification_url`
 * on every charge a credentialed account creates) — `localhost` can't
 * receive an inbound POST from Mercado Pago's servers, so this needs to be
 * whatever public URL currently tunnels to this machine (e.g. localto.net,
 * ngrok). Set `PUBLIC_BASE_URL` in `.env` when that tunnel URL changes.
 * Mock-backed accounts ignore this entirely — they fake payments in-process.
 */
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://stellarsummit.localto.net").replace(/\/+$/, "");

/** Provider names backed by the local simulator (no real `MP_*_ACCESS_TOKEN` configured) — safe to fake a payment for; anything else needs a genuine status check. */
const mockBackedProviders = new Set<string>();

/**
 * A Mercado Pago account: real credentials from the loaded .env file when
 * set. Without a token, test mode falls back to the local simulator (fake
 * payments allowed — tracked in `mockBackedProviders`) while production
 * returns `null` so the account is never registered at all
 * (`REQUIRE_REAL_CREDENTIALS`). `sandbox` comes from `MP_SANDBOX` (see the
 * top of this file) — ALWAYS `true` in test mode (`--env=test`) no matter
 * what, only production mode can flip it to `false` and place a real charge.
 *
 * A real account also gets `notificationUrl` — that's what makes its inbound
 * webhooks land on `/webhooks/<name>` (see the route near the bottom), the
 * only way a genuine payment ever completes an order here: nothing about the
 * real path is faked, so without that URL reaching this process the order
 * just sits pending. It must be a public tunnel to this machine, per
 * `PUBLIC_BASE_URL`.
 */
function buildMercadoPago(name: string, region: string, currency: FiatCurrency, envToken: string | undefined, envWebhookSecret: string | undefined): MercadoPagoProvider | null {
  if (envToken?.trim()) {
    return new MercadoPagoProvider({
      name,
      regions: [region],
      currencies: [currency],
      accessToken: envToken.trim(),
      sandbox: MP_SANDBOX,
      webhookSecret: envWebhookSecret,
      notificationUrl: `${PUBLIC_BASE_URL}/webhooks/${name}`,
      defaultPayerEmail: "buyer@example.com",
      logoUrl: "/assets/logo/mp.svg",
    });
  }
  if (REQUIRE_REAL_CREDENTIALS) {
    skippedProviders.push(`${name} (no ${region === "BR" ? "MP_BR_ACCESS_TOKEN" : "MP_AR_ACCESS_TOKEN"})`);
    return null;
  }
  mockBackedProviders.add(name);
  return new MercadoPagoProvider({
    name,
    regions: [region],
    currencies: [currency],
    accessToken: `TEST-demo-${name}`,
    webhookSecret: WEBHOOK_SECRET,
    defaultPayerEmail: "buyer@example.com",
    fetch: mp.fetchImpl,
    logoUrl: "/assets/logo/mp.svg",
  });
}

const mercadoPagoBr = buildMercadoPago("mercadopago-br", "BR", FiatCurrency.BRL, process.env.MP_BR_ACCESS_TOKEN, process.env.MP_BR_WEBHOOK_SECRET);
const mercadoPagoAr = buildMercadoPago("mercadopago-ar", "AR", FiatCurrency.ARS, process.env.MP_AR_ACCESS_TOKEN, process.env.MP_AR_WEBHOOK_SECRET);

/** Everything that ended up with usable credentials — the picker, `/api/*` and the webhook routes all derive from this and nothing else. */
const activeProviders: PaymentProvider[] = [etherfuseProvider, mercadoPagoBr, mercadoPagoAr].filter((p): p is NonNullable<typeof p> => p !== null);

if (activeProviders.length === 0) {
  console.error(
    `✘ No payment provider has credentials in .env.${DEMO_ENV}, and --env=${DEMO_ENV} won't fall back to the local simulator.\n` +
      `  Set at least one of MP_AR_ACCESS_TOKEN / MP_BR_ACCESS_TOKEN / ETHERFUSE_API_KEY there (see .env.${DEMO_ENV}.example),\n` +
      `  or run \`npm run demo:ui\` (--env=test) to walk the UI against the local simulator instead.`,
  );
  process.exit(1);
}

const ramp = new CosmosRamp({
  providers: activeProviders,
  oracle: oracle(),
  settlement: settlementFn,
});

/** `true` if `providerName` is on the local simulator (safe to fake a payment for) rather than a real, credentialed account. */
function isMockBacked(providerName: string): boolean {
  return mockBackedProviders.has(providerName);
}

console.log(
  `Providers: ${ramp.providers.map((p) => (isMockBacked(p.name) ? p.name : `${p.name} (REAL)`)).join(", ")}`,
);
if (skippedProviders.length) {
  console.log(`Not registered (--env=${DEMO_ENV} requires real credentials): ${skippedProviders.join(", ")}`);
}
console.log(`Mercado Pago mode: ${MP_SANDBOX ? "sandbox — no real charges possible" : "⚠ PRODUCTION — real, chargeable preferences"}`);
// Every credentialed Mercado Pago account POSTs here on each payment update.
// This has to be publicly reachable (PUBLIC_BASE_URL) or those orders never
// leave "pending" — see the /webhooks/ route.
for (const provider of [mercadoPagoBr, mercadoPagoAr]) {
  if (provider && !isMockBacked(provider.name)) console.log(`Webhook notification URL for ${provider.name}: ${PUBLIC_BASE_URL}/webhooks/${provider.name}`);
}

// ---------------------------------------------------------------------------
// Wizard steps — provider → currency → [method] → amount.
// ---------------------------------------------------------------------------

function providersFor(op: Op): readonly PaymentProvider[] {
  // Etherfuse doesn't support payouts in this adapter — leave it out of "sell".
  return op === "sell" ? ramp.providers.filter((p) => !p.name.startsWith("etherfuse")) : ramp.providers;
}

function wizardShell(op: Op, lang: Lang, stepName: string, bodyHtml: string): string {
  const steps = STEPS[op];
  const idx = Math.max(0, steps.indexOf(stepName));
  const backBtn = idx > 0 ? `<button class="back" onclick="goBack()">${t(lang, "back")}</button>` : "<span></span>";
  const dots = steps.map((_, i) => `<span class="dot${i === idx ? " active" : ""}"></span>`).join("");
  const opTitleKey = op === "buy" ? "opBuy" : op === "sell" ? "opSell" : "opQuote";
  const subtitleKey = op === "buy" ? "subtitleBuy" : op === "sell" ? "subtitleSell" : "subtitleQuote";
  const stepLabelKey =
    stepName === "provider" ? "stepProvider" : stepName === "currency" ? "stepCurrency" : stepName === "method" ? "stepMethod" : stepName === "wallet" ? "stepWallet" : "stepAmount";
  return `<div style="width:100%;max-width:480px;box-sizing:border-box;margin:0 auto;background:var(--panel);border-radius:24px;padding:24px;font-family:Helvetica, Arial, sans-serif;color:var(--fg)">
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

function renderProviderBody(op: Op, state: WizardState): string {
  const available = providersFor(op);
  // Only reachable in production, where uncredentialed providers aren't
  // registered at all — e.g. "sell" when the one credentialed provider is
  // Etherfuse, which has no payout path.
  if (available.length === 0) {
    return `<p style="color:var(--muted);font-size:13px;margin:0">No payment provider in this run supports ${op === "sell" ? "payouts" : "this operation"}.</p>`;
  }
  const rows = available
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

function renderCurrencyBody(op: Op, state: WizardState, lang: Lang): string {
  const provider = providersFor(op).find((p) => p.name === state.provider);
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

/**
 * Asks for the buyer's destination wallet before the final "amount" step
 * creates the charge — connected via Stellar Wallets Kit (Freighter, xBull,
 * Albedo, Rabet, Hana, Lobstr), never prefilled or assumed. A small opt-in
 * fallback offers a Friendbot-funded test wallet for people without a
 * browser wallet extension.
 */
function renderWalletBody(state: WizardState, lang: Lang): string {
  const connected = !!state.wallet;
  const addressText = connected ? escapeHtml(shortenAddress(state.wallet!)) : t(lang, "walletNotConnected");
  const manualValue = connected ? escapeHtml(state.wallet!) : "";
  return `<div id="walletConnectCard" style="border:1px solid var(--border);border-radius:10px;padding:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
    <div style="min-width:0">
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">${t(lang, "walletLabel")}</div>
      <div id="walletAddressText" style="font-size:14px;font-weight:700;font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${addressText}</div>
    </div>
    <button type="button" id="connectWalletBtn" onclick="connectWallet()" style="flex-shrink:0;background:${connected ? "transparent" : "var(--cosmos-button-bg)"};color:${connected ? "var(--cosmos-fg)" : "var(--cosmos-button-fg)"};border:${connected ? "1px solid var(--border)" : "none"};border-radius:10px;padding:11px 16px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">${connected ? t(lang, "changeWallet") : t(lang, "connectWallet")}</button>
  </div>
  <div style="display:flex;align-items:center;gap:10px;margin:0 0 12px">
    <div style="flex:1;height:1px;background:var(--border)"></div>
    <span style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">${t(lang, "orLabel")}</span>
    <div style="flex:1;height:1px;background:var(--border)"></div>
  </div>
  <label style="display:block;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px">${t(lang, "manualWalletLabel")}</label>
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <input id="walletManualInput" type="text" placeholder="${t(lang, "walletPlaceholder")}" value="${manualValue}" style="${FIELD_STYLE_TIGHT};margin-bottom:0;flex:1;min-width:0" />
    <button type="button" id="useManualWalletBtn" onclick="useManualWallet()" style="flex-shrink:0;background:var(--cosmos-surface-alt);color:var(--cosmos-fg);border:1px solid var(--border);border-radius:10px;padding:11px 16px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">${t(lang, "useThisAddress")}</button>
  </div>
  ${/* Throwaway wallets need Friendbot, which only exists on testnet. */ ""}
  ${connected || IS_MAINNET ? "" : `<button type="button" id="demoWalletLink" onclick="useDemoWallet()" style="background:none;border:none;color:var(--muted);font-size:12px;text-decoration:underline;cursor:pointer;padding:0;margin-bottom:16px;display:block">${t(lang, "useDemoWallet")}</button>`}
  <p style="color:var(--muted);font-size:12px;margin:0 0 20px">${t(lang, "walletHint")}</p>
  <button onclick="continueWallet()" id="walletContinueBtn" style="${BUTTON_STYLE}"${connected ? "" : " disabled"}>${t(lang, "continueLabel")}</button>`;
}

/** Live, two-way pay/receive quote: editing either field re-quotes the other via /api/quote-preview. */
async function renderBuyAmountBody(state: WizardState, lang: Lang): Promise<string> {
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

async function renderStep(op: Op, stepName: string, state: WizardState, lang: Lang): Promise<string> {
  const body =
    stepName === "provider"
      ? renderProviderBody(op, state)
      : stepName === "currency"
        ? renderCurrencyBody(op, state, lang)
        : stepName === "method"
          ? renderMethodBody(state, lang)
          : stepName === "wallet"
            ? renderWalletBody(state, lang)
            : op === "sell"
              ? renderSellAmountBody(state, lang)
              : op === "quote"
                ? renderQuoteAmountBody(state, lang)
                : await renderBuyAmountBody(state, lang);
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
      qr={qr ?? linkQr}
      qrIsPaymentLink={!qr && !!linkQr}
      paymentLink={link}
      rows={rampOrderToDetailRows(order, { settlementTxUrl: stellarExpertTxUrl })}
    />,
  );
}

/** The status card shown while waiting for the seller's crypto to arrive (no QR — offramp has no charge). */
function renderSellPending(order: RampOrderData, lang: Lang): string {
  return renderToStaticMarkup(
    <ReceivePayment
      title={t(lang, "waitingCrypto")}
      amount={`${order.quote.cryptoAmount} ${order.quote.asset}`}
      rows={rampOrderToDetailRows(order, { settlementTxUrl: stellarExpertTxUrl })}
    />,
  );
}

/** The receipt shown once an order is paid and settled. */
/** Plain-text summary for the receipt's Share button — amount, order id, and the settlement tx (as a Stellar Expert link when it's a real one). */
function receiptShareText(order: RampOrderData): string {
  const amountLine =
    order.direction === "onramp"
      ? `${order.quote.fiatAmount.toFixed(2)} ${order.quote.currency} → ${order.quote.cryptoAmount} ${order.quote.asset}`
      : `${order.quote.cryptoAmount} ${order.quote.asset} → ${order.quote.fiatAmount.toFixed(2)} ${order.quote.currency}`;
  const lines = [`${order.direction === "onramp" ? "Buy" : "Sell"} USDC · ${order.provider}`, amountLine, `Order ${order.id}`];
  if (order.settlementTxId) lines.push(`Tx: ${stellarExpertTxUrl(order.settlementTxId) ?? order.settlementTxId}`);
  return lines.join("\n");
}

function renderReceipt(order: RampOrderData): string {
  const logoUrl = ramp.providers.find((p) => p.name === order.provider)?.logoUrl;
  return renderToStaticMarkup(
    <PaymentConfirmation
      itemTitle={`${order.direction === "onramp" ? "Buy" : "Sell"} USDC · ${order.provider}`}
      itemSubtitle={new Date(order.updatedAt).toLocaleString()}
      logoUrl={logoUrl}
      shareText={receiptShareText(order)}
      rows={rampOrderToDetailRows(order, { settlementTxUrl: stellarExpertTxUrl })}
    />,
  );
}

/** A quote-only summary — no order is created. */
function renderQuoteResult(quote: QuoteBreakdown): string {
  return renderToStaticMarkup(
    <div style={{ width: "100%", maxWidth: 480, boxSizing: "border-box", margin: "0 auto", background: "var(--panel, #fff)", borderRadius: 16, padding: 20, fontFamily: "Helvetica, Arial, sans-serif", color: "var(--fg, #111827)" }}>
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
// real/Etherfuse confirmations, which never go through ramp.handleWebhook —
// see confirmOrder).
// ---------------------------------------------------------------------------

/**
 * Orders whose fiat leg was collected but whose crypto release threw, by id
 * → why. An order like that stays in "settling" (never "completed"), which on
 * its own is indistinguishable from a settlement still in flight — this is
 * what lets `/api/status` tell the buyer their money was taken and the USDC
 * hasn't gone out, instead of spinning on "pending" forever.
 */
const settlementFailures = new Map<string, string>();

async function finalizeOrder(order: RampOrderData): Promise<RampOrderData> {
  await ramp.store.update(order.id, { status: "paid" });
  const settling = (await ramp.store.update(order.id, { status: "settling" }))!;
  let result;
  try {
    result = await settlementFn({ order: settling, asset: settling.quote.asset, amount: settling.quote.cryptoAmount, wallet: settling.wallet });
  } catch (error) {
    const reason = (error as Error).message ?? String(error);
    settlementFailures.set(order.id, reason);
    console.error(`✘ settlement FAILED for order ${order.id} — leaving it in "settling", not completing it: ${reason}`);
    throw error;
  }
  settlementFailures.delete(order.id);
  return (await ramp.store.update(order.id, { status: "completed", settlementTxId: result?.txId }))!;
}

/**
 * Refuse to create a charge the settlement leg couldn't honour. Called
 * BEFORE `ramp.onramp` so a wallet that can't receive the asset costs the
 * buyer nothing — once the charge exists, they can pay it, and for a real
 * Mercado Pago account that money is genuinely gone.
 *
 * The blocking condition is a missing trustline on a wallet whose key the
 * server doesn't hold: `settlementFn` can only bundle a `changeTrust` for the
 * demo wallets in `walletByAddress`, so for a user-connected wallet the
 * trustline has to already exist (the wallet step's prompt opens it via
 * /api/trustline*). Etherfuse is exempt — it releases its own crypto and
 * never touches this demo's asset.
 */
async function assertWalletCanReceive(wallet: string, providerName: string): Promise<void> {
  if (providerName.startsWith("etherfuse")) return;
  if (walletByAddress.has(wallet)) return; // server-held demo wallet — settlement opens the trustline itself
  if (!(await ensureStellarReady())) {
    throw new Error(
      IS_MAINNET
        ? `The payout account isn't ready (distributor ${settlementSource.payer.publicKey()} is unfunded, or Horizon is unreachable), so the ${DEMO_ASSET_CODE} couldn't be delivered. Checkout is blocked until it is.`
        : "Stellar is unreachable right now, so the USDC couldn't be delivered — try again in a moment.",
    );
  }

  if (await accountTrustsAsset(wallet, SETTLEMENT_ASSET)) return;

  throw new Error(
    `${wallet} has no trustline for ${DEMO_ASSET_CODE} (issuer ${SETTLEMENT_ASSET.getIssuer()}), so the ${DEMO_ASSET_CODE} could not be delivered after you paid. ` +
      `Open the trustline first — go back to the wallet step and approve it — then check out again.`,
  );
}

/**
 * Read an order's REAL payment state from the provider API — never a
 * simulation, so an unpaid charge simply reads back as unpaid.
 *
 * A Checkout Pro link can't be looked up by charge id: `order.charge.id` is
 * the *preference* id there, and `/v1/payments/<preferenceId>` doesn't exist,
 * so `getCharge` 404s no matter how genuinely the buyer paid. The payment MP
 * creates carries the preference's `external_reference` (which CosmosRamp
 * sets to the order id), so that's what finds it — see
 * `MercadoPagoProvider.findChargeByReference`. Direct charges (PIX, in-store
 * QR) DO store a real payment id, so they take the plain `getCharge` path.
 *
 * Returns null when there's simply no payment yet.
 */
async function readRealChargeState(order: RampOrderData): Promise<{ status: string } | null> {
  const provider = ramp.providers.find((p) => p.name === order.provider);
  if (!provider || !order.charge) return null;
  if (provider instanceof MercadoPagoProvider && order.charge.method === "link") {
    return await provider.findChargeByReference(order.id);
  }
  return await provider.getCharge(order.charge.id);
}

/**
 * The "Test" confirmation mode's manual control — a deliberate OVERRIDE, not
 * a status check. It forces the order to complete and releases the crypto
 * leg, whatever the fiat leg actually did:
 * - Etherfuse: triggers the REAL sandbox deposit simulation
 *   (`client.sandbox.fiatReceived`), then finalizes.
 * - Mock-backed Mercado Pago: the local simulator's mock webhook flow.
 * - Real Mercado Pago account: SKIPS Mercado Pago entirely. There's no
 *   sandbox "simulate payment" endpoint to call, and requiring a genuine
 *   payment makes the crypto leg impossible to exercise without actually
 *   buying from yourself. So this releases the asset with NO verified fiat
 *   payment — on mainnet that spends real USDC out of the distributor.
 *
 * The unforced path is `/api/status` (the 5s poll), which never fabricates
 * anything: it reads the real charge and only completes an order someone
 * genuinely paid. That's the one a production integration relies on.
 */
async function confirmOrder(orderId: string): Promise<{ resultHtml?: string; pending?: boolean }> {
  const order = await ramp.getOrder(orderId);
  if (!order?.charge) throw new Error("Order not found or has no charge.");

  if (order.provider.startsWith("etherfuse")) {
    if (!etherfuseProvider) throw new Error("Etherfuse is not registered in this run (no ETHERFUSE_API_KEY).");
    await etherfuseProvider.client.sandbox.fiatReceived(order.charge.id);
    const updated = await finalizeOrder(order);
    return { resultHtml: renderReceipt(updated) };
  }

  if (!isMockBacked(order.provider)) {
    if (!ramp.providers.some((p) => p.name === order.provider)) throw new Error(`Provider ${order.provider} is not registered.`);
    console.warn(
      `⚠ FORCED completion of order ${order.id} (${order.provider}) — the manual control does NOT consult Mercado Pago, ` +
        `so no fiat payment has been verified. Releasing ${order.quote.cryptoAmount} ${order.quote.asset}` +
        `${IS_MAINNET ? " of REAL mainnet USDC from the distributor" : " (testnet)"} → ${order.wallet}.`,
    );
    const updated = await finalizeOrder(order);
    return { resultHtml: renderReceipt(updated) };
  }

  // `order.provider`, not a bare "mercadopago": CosmosRamp keys its registry
  // by the exact provider name, and each account here is registered under its
  // own ("mercadopago-ar"/"mercadopago-br"), so anything else is a 404
  // unknown_provider that silently leaves the order pending.
  const hook = await ramp.handleWebhook(order.provider, mp.pay(order.charge.id));
  if (!hook.ok) throw new Error(`Simulated webhook for ${order.provider} was not accepted: ${hook.outcome}`);
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
    const providerName = ramp.providers.some((p) => p.name === body.provider) ? body.provider : ramp.providers[0]!.name;
    const currency = parseCurrency(body.currency);
    const method: Method = currency === "BRL" && body.method === "qr" ? "qr" : "link";
    const requested = Number(body.amount);
    const amount = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_FIAT_AMOUNT[currency];
    const lang: Lang = STRINGS[body.lang as Lang] ? body.lang : "en";

    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    if (!wallet) throw new Error("Connect a destination wallet before checking out.");

    // Check the crypto leg CAN be delivered before asking anyone for money.
    // Settlement can't open a trustline for a wallet whose key the server
    // doesn't hold, so a missing one means the fiat gets collected and the
    // USDC never arrives — the exact way to lose a buyer's funds. Fail here,
    // where nothing has been charged yet, rather than at settlement.
    await assertWalletCanReceive(wallet, providerName);

    const order = await ramp.onramp({
      provider: providerName,
      amount,
      currency: toFiatCurrency(currency),
      spread: 0.02,
      wallet,
      method,
      description: "Buy USDC (demo)",
    });
    return { orderId: order.id, resultHtml: await renderPending(order, lang) };
  },

  /** Opt-in fallback for the wallet step's "no wallet installed?" link — a fresh, Friendbot-funded testnet address. */
  async demoWallet() {
    return { wallet: await generateDemoWallet() };
  },

  /** Whether `wallet` already trusts the demo USDC asset — the wallet step checks this before checkout to decide whether to prompt for a trustline. */
  async checkTrustline(body) {
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    if (!isValidStellarAddress(wallet)) return { trusts: false };
    return { trusts: await accountTrustsAsset(wallet, SETTLEMENT_ASSET) };
  },

  /**
   * Builds an UNSIGNED `changeTrust` transaction (source = `wallet`) for the
   * demo USDC asset — the browser signs it with whichever wallet the user
   * connected (Stellar Wallets Kit's `signTransaction`, see
   * wallet-kit-client.ts), then POSTs the signed XDR to `submitTrustline`
   * below. The server never touches this wallet's private key. On testnet,
   * auto-funds `wallet` via Friendbot first if it has no XLM yet — common for
   * a freshly created wallet — since an account needs to exist to have a
   * sequence number to build a transaction from. On mainnet there's no
   * Friendbot: an account that doesn't exist yet has to be funded by its
   * owner, and a trustline needs an extra ~0.5 XLM of reserve on top.
   */
  async trustlineTransaction(body) {
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    if (!isValidStellarAddress(wallet)) throw new Error("Invalid Stellar address.");
    if (!(await ensureStellarReady())) throw new Error("Stellar is unreachable right now — try again in a moment.");
    let account;
    try {
      account = await stellarServer.loadAccount(wallet);
    } catch {
      if (IS_MAINNET) {
        throw new Error(`${wallet} doesn't exist on Stellar mainnet yet — fund it with at least ~1.5 XLM (base reserve plus the trustline's), then try again.`);
      }
      await stellarServer.friendbot(wallet).call();
      account = await stellarServer.loadAccount(wallet);
    }
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE }).addOperation(Operation.changeTrust({ asset: SETTLEMENT_ASSET })).setTimeout(60).build();
    return { xdr: tx.toXDR(), networkPassphrase: NETWORK_PASSPHRASE };
  },

  /** Submits a client-signed `changeTrust` XDR (from `trustlineTransaction`) to the configured Stellar network. */
  async submitTrustline(body) {
    const xdr = typeof body.xdr === "string" ? body.xdr : "";
    if (!xdr) throw new Error("Missing signed transaction.");
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
    const result = await stellarServer.submitTransaction(tx);
    return { txHash: result.hash };
  },

  async confirm(body) {
    return confirmOrder(body.orderId);
  },

  /**
   * The "Real" confirmation mode's 5s poll. Never forces a payment or
   * crypto-received event — it reports the order's real state and nothing
   * else. A production integration would land that state purely from its
   * webhook handler.
   *
   * This demo can't rely on the webhook alone: it only arrives if
   * `PUBLIC_BASE_URL` currently tunnels to this machine, and a tunnel that's
   * down or stale leaves a genuinely-paid order stuck on "pending" forever
   * with nothing on screen to explain it. So for a real (non-mock) provider
   * whose order hasn't landed yet, this also reads the charge straight from
   * the provider API — the same read `confirm` does, and just as unable to
   * invent an approval: an unpaid charge stays pending either way. Whichever
   * path sees the payment first wins; `finalizeOrder`/`handleWebhook` both
   * no-op on an order that's already past "pending".
   */
  async status(body) {
    let order = await ramp.getOrder(body.orderId);
    if (!order) throw new Error("Order not found.");

    if (order.status === "created" && order.charge && !isMockBacked(order.provider)) {
      let approved = false;
      try {
        approved = (await readRealChargeState(order))?.status === "approved";
      } catch (error) {
        // Provider unreachable / charge not queryable — stay quiet on the
        // wire and let the next tick (or the webhook) try again.
        console.error(`status poll [${order.provider}] could not read the charge:`, (error as Error).message ?? error);
      }
      if (approved) {
        console.log(`status poll [${order.provider}]: order ${order.id} is paid — settling (webhook did not get there first)`);
        // Settlement failures surface below via `settlementFailures` rather
        // than bubbling out of the poll as a generic error.
        order = await finalizeOrder(order).catch(() => order!);
      }
    }

    // Paid but undelivered — the one state the buyer must not be left
    // guessing about, since their money is already gone.
    const settlementError = settlementFailures.get(order.id);
    if (settlementError) return { done: true, failed: true, message: settlementError };

    if (order.status === "completed") return { done: true, resultHtml: renderReceipt(order) };
    if (order.status === "failed" || order.status === "expired" || order.status === "canceled") {
      return { done: true, failed: true };
    }
    return { done: false };
  },

  /** Creates an offramp order (crypto → fiat) and returns the "waiting for your USDC" view. */
  async sell(body) {
    // Can legitimately be empty now: Etherfuse has no payout path, so a
    // production run credentialed for Etherfuse alone supports no "sell".
    const sellProviders = providersFor("sell");
    if (sellProviders.length === 0) throw new Error("No provider in this run supports payouts — selling is unavailable.");
    const providerName = sellProviders.some((p) => p.name === body.provider) ? body.provider : sellProviders[0]!.name;
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
    const order = await ramp.confirmCryptoReceived(body.orderId, { txId: "0xincoming-demo" });
    return { resultHtml: renderReceipt(order) };
  },

  /** Pure quote — no order created. Pricing is oracle-based, not provider-specific; `provider` is accepted for UI consistency. */
  async quote(body) {
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
  if (req.method === "GET" && url.pathname === "/assets/wallet-kit.js") {
    try {
      const code = await getWalletKitBundle();
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" }).end(code);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/javascript" }).end(`console.error(${JSON.stringify(`wallet-kit bundle failed: ${String(error)}`)});`);
    }
    return;
  }
  /**
   * Real inbound Mercado Pago webhooks — this is what `notificationUrl`
   * (see `buildMercadoPago`/`PUBLIC_BASE_URL`) points at. One route per
   * registered provider name, e.g. /webhooks/mercadopago-br, since each
   * account is a separate `MercadoPagoProvider` instance here (compare
   * examples/mercadopago/webhook-server.ts, which uses a single
   * multi-account provider and one fixed path instead).
   */
  if (req.method === "POST" && url.pathname.startsWith("/webhooks/")) {
    const providerName = url.pathname.slice("/webhooks/".length);
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      // Log what arrived before handling it. Mercado Pago sends several
      // notification shapes (Webhooks v2 `type`+`data.id`, IPN
      // `topic`+`id`, merchant_order) and an unexpected outcome is almost
      // impossible to diagnose from the outcome alone.
      const query = url.search || "(no query)";
      console.log(`webhook [${providerName}] ← ${query} signed=${req.headers["x-signature"] ? "yes" : "NO"} body=${raw.slice(0, 200) || "(empty)"}`);
      try {
        const result = await ramp.handleWebhook(providerName, { body: raw, headers: req.headers, url: req.url });
        console.log(`webhook [${providerName}]: ${result.outcome}${result.orderId ? ` (order ${result.orderId})` : ""}`);
        if (result.outcome === "invalid_signature") {
          console.warn(`  ↳ x-signature didn't match. Check MP_${providerName.endsWith("-br") ? "BR" : "AR"}_WEBHOOK_SECRET in .env.${DEMO_ENV} against the app's Webhooks panel.`);
        }
        res.writeHead(result.status).end();
      } catch (error) {
        console.error(`webhook [${providerName}] error:`, error);
        res.writeHead(500).end();
      }
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/step") {
    const op: Op = url.searchParams.get("op") === "sell" ? "sell" : url.searchParams.get("op") === "quote" ? "quote" : "buy";
    const stepName = url.searchParams.get("step") || "provider";
    const lang: Lang = STRINGS[url.searchParams.get("lang") as Lang] ? (url.searchParams.get("lang") as Lang) : "en";
    const amountParam = url.searchParams.get("amount");
    const currencyParam = url.searchParams.get("currency");
    const state: WizardState = {
      provider: url.searchParams.get("provider") || null,
      currency: currencyParam ? parseCurrency(currencyParam) : null,
      method: url.searchParams.get("method") === "qr" ? "qr" : url.searchParams.get("method") === "link" ? "link" : null,
      wallet: url.searchParams.get("wallet") || null,
      amount: amountParam ? Number(amountParam) : null,
    };
    const providers = providersFor(op).map((p) => ({ name: p.name, currencies: p.currencies }));
    const html = await renderStep(op, stepName, state, lang);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ html, providers }));
    return;
  }
  /** Live re-quote for the buy amount step: pass either `amount` (fiat) or `cryptoAmount`, get the other back. Provider-agnostic — pricing is oracle-based. */
  if (req.method === "GET" && url.pathname === "/api/quote-preview") {
    const currency = parseCurrency(url.searchParams.get("currency"));
    const amountParam = url.searchParams.get("amount");
    const cryptoParam = url.searchParams.get("cryptoAmount");
    try {
      const quote = await ramp.quote({
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

const INITIAL_PROVIDERS = JSON.stringify(providersFor("buy").map((p) => ({ name: p.name, currencies: p.currencies })));

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
  main { width: 100%; max-width: 480px; }
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

  /* Trustline modal — shown from the wallet step when the destination has no trustline for the demo USDC asset yet. */
  #trustline-backdrop {
    position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,.45);
    display: none; align-items: center; justify-content: center; padding: 20px;
  }
  #trustline-backdrop.open { display: flex; }
  #trustline-modal {
    width: 100%; max-width: 380px; background: var(--panel); color: var(--fg); border-radius: 20px;
    padding: 24px; box-shadow: 0 12px 40px rgba(0,0,0,.24); animation: viewEnter .2s cubic-bezier(.16,1,.3,1) both;
  }
  #trustline-modal h2 { font-size: 17px; margin: 0 0 10px; }
  #trustline-modal p { font-size: 13px; color: var(--muted); margin: 0 0 20px; line-height: 1.5; }
  #trustline-modal .primary {
    width: 100%; background: var(--cosmos-button-bg); color: var(--cosmos-button-fg); border: none;
    border-radius: 14px; padding: 14px; font-size: 14px; font-weight: 700; cursor: pointer; font: inherit; margin-bottom: 8px;
  }
  #trustline-modal .secondary {
    width: 100%; background: none; color: var(--muted); border: none; padding: 10px; font-size: 13px; cursor: pointer; font: inherit;
  }
  #trustline-modal .status { font-size: 13px; text-align: center; margin: 0 0 12px; }
  #trustline-modal .status.error { color: #DC2626; }
  #trustline-modal .status.success { color: #16A34A; }

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

  /* The receipt's Print button (data-cosmos-action="print" in PaymentConfirmation.tsx) — show just the receipt card, not the rest of the wizard chrome. */
  @media print {
    #top-right, #fab-wrap, #toast-stack, #trustline-backdrop, #actions, .cosmos-no-print { display: none !important; }
    body { padding: 0; background: #fff; }
  }
</style>
</head>
<body>
<div id="toast-stack" aria-live="polite"></div>
<div id="trustline-backdrop"><div id="trustline-modal" role="dialog" aria-modal="true"></div></div>
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
  <div id="view">${await renderStep("buy", "provider", { provider: null, currency: null, method: null, wallet: null, amount: null }, "en")}</div>
  <div id="actions"></div>
</main>
<div id="fab-wrap">
  <div id="fab-menu" class="fab-menu"></div>
  <button id="fab" onclick="toggleFab()" aria-label="Choose operation">☰</button>
</div>
<script src="/assets/wallet-kit.js"></script>
<script>
  var STEPS = ${JSON.stringify(STEPS)};
  var STR_DICT = ${JSON.stringify(STRINGS)};
  var lang = 'en';
  var op = 'buy';
  var uiMode = 'wizard';
  var stepIdx = 0;
  var state = { provider: null, currency: null, method: null, wallet: null, walletSource: null, amount: null };
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
      var res = await fetch('/api/status', { method: 'POST', body: JSON.stringify({ orderId: orderId }) });
      var data = await res.json();
      if (data.error || !data.done) return;
      stopPolling();
      pendingKind = null;
      if (data.failed) {
        // data.message carries a settlement failure — the buyer paid and the
        // crypto did NOT go out. Keep the order view on screen (its id is
        // what a retry needs) instead of clearing it like a plain failure.
        showToast(data.message || STR('genericError'), 'error');
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
      setTimeout(function () { el.innerHTML = html; wirePaymentLink(el); }, 150);
    } else {
      el.innerHTML = html;
      wirePaymentLink(el);
    }
  }

  /**
   * ReceivePayment locks its payment-link button after one click, but that
   * lock is React state and this page renders the component to static markup
   * with no hydration — so the same behavior is re-applied here over the
   * data- attributes the component emits. Opening a hosted checkout over and
   * over just leaves a pile of tabs racing on one charge; the button comes
   * back after the lock window in case the buyer closed the tab or the
   * payment bounced.
   */
  function wirePaymentLink(root) {
    var link = root && root.querySelector('[data-cosmos-payment-link]');
    if (!link || link.dataset.lockWired) return;
    link.dataset.lockWired = '1';
    var lockMs = Number(link.dataset.lockMs || 0);
    if (!(lockMs > 0)) return;

    var openLabel = link.textContent;
    var lockedLabel = link.dataset.lockedLabel || openLabel;
    var open = { background: link.style.background, color: link.style.color, cursor: link.style.cursor };

    link.addEventListener('click', function (event) {
      if (link.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      link.setAttribute('aria-disabled', 'true');
      link.style.pointerEvents = 'none';
      link.style.background = 'var(--cosmos-surface-alt, #F3F4F6)';
      link.style.color = 'var(--cosmos-muted, #9CA3AF)';
      link.style.cursor = 'default';
      link.textContent = lockedLabel;
      setTimeout(function () {
        if (!link.isConnected) return; // order completed — this view is gone
        link.removeAttribute('aria-disabled');
        link.style.pointerEvents = '';
        link.style.background = open.background;
        link.style.color = open.color;
        link.style.cursor = open.cursor;
        link.textContent = openLabel;
      }, lockMs);
    });
  }

  async function fetchStep() {
    var stepName = STEPS[op][stepIdx];
    var qs = new URLSearchParams({ op: op, step: stepName, lang: lang, provider: state.provider || '' });
    if (state.currency) qs.set('currency', state.currency);
    if (state.method) qs.set('method', state.method);
    if (state.wallet) qs.set('wallet', state.wallet);
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
    var qs = new URLSearchParams({ currency: state.currency || 'ARS' });
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
          stepIdx = op === 'buy' ? STEPS[op].indexOf('wallet') : STEPS[op].indexOf('amount');
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
        stepIdx = op === 'buy' ? STEPS[op].indexOf('wallet') : STEPS[op].indexOf('amount');
        await fetchStep();
        return;
      }
    }
    stepIdx++;
    await fetchStep();
  }

  var STEP_FIELDS = ['provider', 'currency', 'method', 'wallet', 'amount'];

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
    if (landingIdx <= STEP_FIELDS.indexOf('wallet')) state.walletSource = null;
    fetchStep();
  }

  function shortenAddress(addr) {
    if (!addr || addr.length <= 12) return addr || '';
    return addr.slice(0, 4) + '…' + addr.slice(-4);
  }

  function isValidStellarAddress(addr) {
    return /^G[A-Z2-7]{55}$/.test(addr || '');
  }

  /**
   * Shared by connectWallet(), useDemoWallet() and useManualWallet(): reflects
   * the chosen address in the wallet card and unlocks Continue. 'source'
   * ('kit' | 'demo' | 'manual') drives continueWallet()'s trustline check:
   * only a 'kit' wallet can sign its own changeTrust here in the browser; a
   * 'demo' wallet's key is held server-side (settlement opens its trustline
   * itself); a 'manual' address can only be warned, never signed for.
   */
  function applyWalletConnected(address, source) {
    state.wallet = address;
    state.walletSource = source;
    var textEl = document.getElementById('walletAddressText');
    if (textEl) textEl.textContent = shortenAddress(address);
    var manualInput = document.getElementById('walletManualInput');
    if (manualInput) manualInput.value = address;
    var connectBtn = document.getElementById('connectWalletBtn');
    if (connectBtn) {
      connectBtn.style.background = 'transparent';
      connectBtn.style.color = 'var(--cosmos-fg)';
      connectBtn.style.border = '1px solid var(--border)';
    }
    var demoLink = document.getElementById('demoWalletLink');
    if (demoLink) demoLink.remove();
    var continueBtn = document.getElementById('walletContinueBtn');
    if (continueBtn) continueBtn.disabled = false;
  }

  /** Opens Stellar Wallets Kit's auth modal (wallet picker + connect + fetch address) via the bundle loaded from /assets/wallet-kit.js. */
  async function connectWallet() {
    var btn = document.getElementById('connectWalletBtn');
    if (btn && btn.disabled) return;
    setButtonLoading(btn, true);
    try {
      var address = await window.connectStellarWallet();
      applyWalletConnected(address, 'kit');
      setButtonLoading(btn, false, STR('changeWallet'));
    } catch (err) {
      setButtonLoading(btn, false);
      showToast(STR('walletConnectError'), 'error');
    }
  }

  /** Opt-in fallback for people without a browser wallet extension — never used unless explicitly clicked. */
  async function useDemoWallet() {
    var btn = document.getElementById('demoWalletLink');
    if (!btn || btn.disabled) return;
    setButtonLoading(btn, true);
    try {
      var res = await fetch('/api/demoWallet', { method: 'POST', body: '{}' });
      var data = await res.json();
      if (data.error || !data.wallet) throw new Error(data.error || 'no wallet');
      applyWalletConnected(data.wallet, 'demo');
      var connectBtn = document.getElementById('connectWalletBtn');
      setButtonLoading(connectBtn, false, STR('changeWallet'));
    } catch (err) {
      setButtonLoading(btn, false);
      showToast(STR('walletConnectError'), 'error');
    }
  }

  /** For remittances/paying on someone else's behalf — no wallet connection needed, just a valid-looking address. */
  function useManualWallet() {
    var input = document.getElementById('walletManualInput');
    var value = input ? input.value.trim() : '';
    if (!isValidStellarAddress(value)) {
      showToast(STR('walletInvalid'), 'error');
      return;
    }
    applyWalletConnected(value, 'manual');
  }

  function proceedPastWallet() {
    stepIdx++;
    fetchStep();
  }

  /**
   * Before leaving the wallet step: a 'demo' wallet's key is held
   * server-side, so settlement opens its trustline itself — no check needed.
   * Anything else gets checked against Horizon; if it's missing, a 'kit'
   * wallet can sign its own changeTrust right here (openTrustlineModal), a
   * 'manual' address can only be warned (we don't hold its key) since
   * settlement will otherwise fall back to a simulated tx id.
   */
  async function continueWallet() {
    if (!state.wallet) {
      showToast(STR('walletRequired'), 'error');
      return;
    }
    if (state.walletSource === 'demo') {
      proceedPastWallet();
      return;
    }
    var btn = document.getElementById('walletContinueBtn');
    setButtonLoading(btn, true);
    try {
      var res = await fetch('/api/checkTrustline', { method: 'POST', body: JSON.stringify({ wallet: state.wallet }) });
      var data = await res.json();
      setButtonLoading(btn, false);
      if (data.trusts) {
        proceedPastWallet();
        return;
      }
    } catch (err) {
      setButtonLoading(btn, false);
      // Couldn't check. Don't wave it through: an unverified trustline is
      // exactly the case where the buyer pays and the USDC can't be
      // delivered. Checkout re-checks server-side and would refuse anyway.
      showToast(STR('trustlineCheckFailed'), 'error');
      return;
    }
    openTrustlineModal();
  }

  /** Renders the trustline prompt — an interactive "sign now" flow for a connected wallet, a plain warning (with no way to act on it) for a manually-pasted address. */
  function openTrustlineModal() {
    var isKit = state.walletSource === 'kit';
    var modal = document.getElementById('trustline-modal');
    modal.innerHTML =
      '<h2>' + STR('trustlineTitle') + '</h2>' +
      '<p>' + STR(isKit ? 'trustlineBodyKit' : 'trustlineBodyManual') + '</p>' +
      '<div id="trustline-status"></div>' +
      (isKit ? '<button type="button" class="primary" id="trustlineEnableBtn" onclick="enableTrustline()">' + STR('trustlineEnable') + '</button>' : '') +
      // No "continue anyway": without the trustline the asset cannot be
      // delivered, and checkout refuses the order anyway
      // (assertWalletCanReceive). Offering it would only lead somewhere that
      // dead-ends, or — before that gate existed — to paying for nothing.
      '<button type="button" class="secondary" onclick="closeTrustlineModal(false)">' + STR('trustlineBack') + '</button>';
    document.getElementById('trustline-backdrop').classList.add('open');
  }

  function closeTrustlineModal(thenProceed) {
    document.getElementById('trustline-backdrop').classList.remove('open');
    if (thenProceed) proceedPastWallet();
  }

  function setTrustlineStatus(message, kind) {
    var el = document.getElementById('trustline-status');
    if (el) el.innerHTML = message ? '<p class="status' + (kind ? ' ' + kind : '') + '">' + message + '</p>' : '';
  }

  /** The connected wallet signs its own changeTrust (server never sees its key) — see wallet-kit-client.ts's signStellarTransaction. */
  async function enableTrustline() {
    var btn = document.getElementById('trustlineEnableBtn');
    if (btn && btn.disabled) return;
    setButtonLoading(btn, true);
    setTrustlineStatus(STR('trustlineChecking'));
    try {
      var buildRes = await fetch('/api/trustlineTransaction', { method: 'POST', body: JSON.stringify({ wallet: state.wallet }) });
      var buildData = await buildRes.json();
      if (buildData.error) throw new Error(buildData.error);
      var signedXdr = await window.signStellarTransaction(buildData.xdr, state.wallet, buildData.networkPassphrase);
      var submitRes = await fetch('/api/submitTrustline', { method: 'POST', body: JSON.stringify({ xdr: signedXdr }) });
      var submitData = await submitRes.json();
      if (submitData.error) throw new Error(submitData.error);
      setButtonLoading(btn, false);
      setTrustlineStatus(STR('trustlineSuccess'), 'success');
      setTimeout(function () { closeTrustlineModal(true); }, 900);
    } catch (err) {
      setButtonLoading(btn, false);
      setTrustlineStatus(STR('trustlineError'), 'error');
    }
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
        body: JSON.stringify({ provider: state.provider, currency: state.currency, method: state.method, wallet: state.wallet, amount: state.amount, lang: lang }),
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
      var res = await fetch('/api/' + endpoint, { method: 'POST', body: JSON.stringify({ orderId: orderId, lang: lang }) });
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
    state = { provider: null, currency: null, method: null, wallet: null, walletSource: null, amount: null };
    document.getElementById('actions').innerHTML = '';
    document.getElementById('fab-menu').classList.remove('open');
    fetchStep();
  }

  document.addEventListener('click', function (e) {
    var fabWrap = document.getElementById('fab-wrap');
    if (!fabWrap.contains(e.target)) document.getElementById('fab-menu').classList.remove('open');
    var langWrap = document.getElementById('lang-switch');
    if (!langWrap.contains(e.target)) document.getElementById('langMenu').classList.remove('open');
    // Delegated so it works for every DetailRow rendered with copyable:true
    // (settlement tx, etc.) regardless of how many times #view gets swapped —
    // see DetailRow.tsx's docstring for why this can't just be a React onClick.
    var copyBtn = e.target.closest && e.target.closest('[data-copy-value]');
    if (copyBtn) {
      var value = copyBtn.getAttribute('data-copy-value');
      navigator.clipboard.writeText(value).then(function () {
        showToast(STR('copiedToClipboard'), 'success');
      }).catch(function () {
        showToast(STR('genericError'), 'error');
      });
    }
    // Same story as the copy button above — PaymentConfirmation.tsx's Print
    // and Share buttons are plain data-cosmos-action="..." markers for
    // exactly this reason (no hydration here to back a real onClick).
    var printBtn = e.target.closest && e.target.closest('[data-cosmos-action="print"]');
    if (printBtn) window.print();
    var shareBtn = e.target.closest && e.target.closest('[data-cosmos-action="share"]');
    if (shareBtn) {
      var shareText = shareBtn.getAttribute('data-share-text') || '';
      if (navigator.share) {
        navigator.share({ text: shareText }).catch(function () {
          // Cancelled or blocked by the browser — not an error worth surfacing.
        });
      } else {
        navigator.clipboard.writeText(shareText).then(function () {
          showToast(STR('copiedToClipboard'), 'success');
        }).catch(function () {
          showToast(STR('genericError'), 'error');
        });
      }
    }
  });
</script>
</body>
</html>`;
