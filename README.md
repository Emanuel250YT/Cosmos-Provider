# cosmos-providers

Crypto onramp/offramp toolkit for Latin America. Collect fiat with regional payment rails (Mercado Pago payment links & PIX, SPEI) and release stablecoins automatically, priced with CoinGecko plus your own spread. Also ships full on/off-ramp anchors to USDC on Stellar — Etherfuse, Koywe, and composable SEP-1/10/24 helpers for any SEP-compliant anchor.

**Documentation in other languages:** [Español](./readme/README.es.md) · [Português](./readme/README.pt-BR.md)

## Install

```bash
npm install cosmos-providers
```

Node ≥ 18, ESM and CJS both work, TypeScript types included. No SDK dependency for any provider — everything talks to the raw REST API with `fetch`.

## Quickstart: Mercado Pago payment link

The fastest way to see the library do something real. Payment link (Checkout Pro) is the rail to start with — it works in every Mercado Pago market and is the one you can actually exercise with test/sandbox credentials (PIX below cannot be tested in sandbox at all).

1. Get an access token from your [Mercado Pago developer panel](https://www.mercadopago.com.ar/developers/panel/app) — `APP_USR-...` works fine here, `sandbox: true` below is what puts the *call* in test mode, not the token's prefix.
2. Save this as `quickstart.ts`:

```ts
import { MercadoPagoProvider } from "cosmos-providers";

const mercadopago = new MercadoPagoProvider({
  accessToken: process.env.MP_ACCESS_TOKEN!,
  sandbox: true, // see "Sandbox vs. production" below for why this is explicit
});

const charge = await mercadopago.createPaymentLink({
  amount: 5000,
  currency: "ARS",
  reference: `order-${Date.now()}`,
  description: "cosmos-providers quickstart",
});

console.log("Pay here:", charge.link);
```

3. Run it:

```bash
MP_ACCESS_TOKEN="your-token" npx tsx quickstart.ts
```

That's it — `charge.link` is a real Checkout Pro URL. The rest of this README builds up from here: PIX, automatic USDC settlement, other providers, custom providers, and the full `CosmosRamp` engine.

Every example below is copy-paste-runnable the same way: save it, set the env vars it names, `npx tsx <file>.ts`. The [`examples/`](./examples) folder has the complete, runnable version of each one, plus `npm run flow:all` to run everything in sequence.

## Features

- **Provider-agnostic** — one engine, pluggable regional providers (Mercado Pago included, PIX/SPEI via Etherfuse, or write your own).
- **Automatic onramp** — build a QR or payment link; when the payment is approved the engine releases USDC (or any asset) to the user's wallet.
- **Automatic offramp** — quote crypto → fiat and pay out through the provider.
- **CoinGecko pricing with spread** — the rate and your spread are locked when the payment is built.
- **Webhooks, both ways** — consumes provider webhooks automatically (signature check included) and emits your own signed webhooks.
- **TypeScript, zero heavy deps** — works on Node ≥ 18. Bring your own wallet/signer; the library never touches private keys.

## Configuration

The library itself never reads `process.env` — every option is passed in explicitly, in your own code (this matters for things like Mercado Pago's sandbox flag, see below — it's a config value you set, never something inferred from an env var or a token's format). `.env.example` documents the variables the scripts in [`examples/`](./examples) read:

```bash
cp .env.example .env
```

## Try it locally (no credentials needed)

The repo ships a Mercado Pago simulator so you can run every action offline:

```bash
npm run demo      # console runner: quote → link → QR → webhook → auto USDC release → offramp
npm run demo:ui   # web playground at http://localhost:4000 with one button per action
```

## Mercado Pago: payment link vs. PIX

Mercado Pago's payment link (Checkout Pro) and PIX are genuinely different ways to collect money — different endpoints, different requirements, and PIX only exists in Brazil — so they're two separate methods, not one method with a flag.

| | `createPaymentLink` | `createPixCharge` |
|---|---|---|
| Markets | AR, BR, MX, CL, CO, PE, UY | Brazil (BRL) only |
| Returns | `charge.link` (hosted checkout URL) | `charge.qr` (EMV "copia e cola") + `charge.qrBase64` |
| **Works in sandbox?** | **Yes** | **No — production only** |

```ts
// examples/mercadopago-payment-link.ts — run: npx tsx examples/mercadopago-payment-link.ts
const charge = await mercadopago.createPaymentLink({
  amount: 5000,
  currency: "ARS", // or "BRL", "MXN", ...
  reference: "order-1",
  description: "Buy USDC",
});
charge.link; // hosted checkout URL
```

```ts
// examples/mercadopago-pix.ts — run: npx tsx examples/mercadopago-pix.ts
const charge = await mercadopago.createPixCharge({
  amount: 50, // BRL, always
  reference: "order-2",
});
charge.qr;       // EMV "copia e cola" string, scannable as-is
charge.qrBase64; // ready-to-embed PNG, if you'd rather show an image
```

**PIX has no sandbox.** Mercado Pago only grants the Payments API scope PIX needs to real, production merchant accounts — a test/sandbox account gets a 401 ("Unauthorized use of live credentials") no matter what you send. `createPixCharge` checks this and throws a clear error immediately if you point it at an account resolved as sandbox, instead of letting that confusing 401 surface. Use `createPaymentLink` to exercise the BRL rail safely in sandbox; PIX itself can only be tested against your real account.

### Sandbox vs. production

`sandbox: true/false` on `MercadoPagoProvider` is a plain, explicit config value — never inferred from the token. Mercado Pago issues the *same* `APP_USR-...` prefix for real merchant accounts and for every "usuario de prueba" (test user / sandbox account) you create under them, so the prefix alone can't tell the two apart. Decide it in your own code:

```ts
new MercadoPagoProvider({
  accessToken: process.env.MP_ACCESS_TOKEN!,
  sandbox: true, // you know which kind of account this token belongs to — the library doesn't
});
```

(A literal `TEST-...` token — the other credential format Mercado Pago issues — *is* unambiguous and defaults `sandbox` to `true` automatically if you don't set it. `APP_USR-...` never defaults to sandbox on its own.)

### Multi-account: one merchant per country

Mercado Pago issues a **separate merchant account** (and access token) per country — an Argentina token can't process a Brazil/PIX charge, and there's no such thing as a "default" account across countries. Pass every account into one provider instance keyed by currency, and every call routes to the right one automatically:

```ts
const mercadopago = new MercadoPagoProvider({
  accounts: {
    ARS: { accessToken: process.env.MP_AR_ACCESS_TOKEN!, sandbox: true },
    BRL: { accessToken: process.env.MP_BR_ACCESS_TOKEN!, sandbox: true },
  },
});

await mercadopago.createPaymentLink({ amount: 5000, currency: "ARS", reference: "ar-1" }); // uses the AR account
await mercadopago.createPaymentLink({ amount: 50, currency: "BRL", reference: "br-1" });   // uses the BR account
```

### Webhook verification

```ts
import { MercadoPagoProvider } from "cosmos-providers";

const mercadopago = new MercadoPagoProvider({
  accessToken: process.env.MP_ACCESS_TOKEN!,
  webhookSecret: process.env.MP_WEBHOOK_SECRET, // from the app's dashboard, "Webhooks" section
});

app.post("/webhooks/mercadopago", express.json(), async (req, res) => {
  const ok = await mercadopago.verifyWebhook({ body: req.body, headers: req.headers, url: req.url });
  if (!ok) return res.sendStatus(401);
  const notification = await mercadopago.parseWebhook({ body: req.body, headers: req.headers });
  // notification.chargeId -> re-fetch it with mercadopago.getCharge(id) and trust *that*, never the webhook body
  res.sendStatus(200);
});
```

To test webhooks without exposing a public URL, build a signed notification for a sandbox payment yourself:

```ts
const request = await mercadopago.buildTestWebhook(paymentId); // signed exactly like Mercado Pago would
await mercadopago.verifyWebhook(request); // true
```

## Automatic settlement with CosmosRamp

Everything above talks to Mercado Pago directly — you decide what happens after a charge is created. `CosmosRamp` is the layer above that: it builds the charge, watches for the webhook, verifies the paid amount, and releases crypto for you.

```ts
import { CosmosRamp, CoinGeckoOracle, MercadoPagoProvider } from "cosmos-providers";

const ramp = new CosmosRamp({
  providers: [
    new MercadoPagoProvider({ accessToken: process.env.MP_ACCESS_TOKEN!, sandbox: true }),
  ],
  oracle: new CoinGeckoOracle(),
  // Your code that sends the crypto. Called automatically after payment.
  settlement: async ({ wallet, amount, asset }) => {
    const txId = await myWallet.transfer(asset, amount, wallet);
    return { txId };
  },
});

// 1. Build the payment. Rate + spread are locked right here.
const order = await ramp.onramp({
  provider: "mercadopago",
  amount: 5000,            // ARS the user will pay
  currency: "ARS",
  asset: "USDC",
  spread: 0.02,             // your 2% margin over the CoinGecko rate
  wallet: "USER_WALLET_ADDRESS",
  method: "link",           // or "qr" for PIX (production only, see above)
});

console.log(order.charge.link);        // send the user here to pay
console.log(order.quote.cryptoAmount); // USDC they will receive
```

```ts
// 2. Receive the Mercado Pago webhook. That's it — the engine verifies the
// signature, checks the paid amount, and calls your settlement.
app.post("/webhooks/mercadopago", express.json(), async (req, res) => {
  const result = await ramp.handleWebhook("mercadopago", {
    body: req.body,
    headers: req.headers,
    url: req.url,
  });
  res.sendStatus(result.status);
});
```

```ts
// 3. Optional: listen to what happens.
ramp.on("payment:approved", (order) => console.log("paid", order.id));
ramp.on("settlement:released", (order, { txId }) => console.log("USDC sent", txId));
ramp.on("order:completed", (order) => console.log("done", order.id));
```

### How the quote works

When you build a payment, the engine asks CoinGecko for the mid-market rate and applies your spread **at that moment**:

| | Effective rate | Example (rate 1000, spread 2%) |
|---|---|---|
| Onramp | `rate * (1 + spread)` | user pays 1020 ARS per USDC |
| Offramp | `rate * (1 - spread)` | user receives 980 ARS per USDC |

The full breakdown is stored on the order:

```ts
order.quote;
// { asset: "USDC", currency: "ARS", rate: 1000, spread: 0.02,
//   effectiveRate: 1020, fiatAmount: 5000, cryptoAmount: 4.901961, quotedAt: ... }
```

You can also quote without creating an order:

```ts
const quote = await ramp.quote({ direction: "onramp", currency: "ARS", amount: 5000, spread: 0.02 });
```

### Offramp: buy USDC back, pay out fiat

```ts
const order = await ramp.offramp({
  provider: "mercadopago",
  cryptoAmount: 100,               // USDC the user sends you
  currency: "ARS",
  spread: 0.02,
  destination: { email: "user@example.com" }, // Mercado Pago payout destination
});

// Show the user your treasury wallet; when their USDC arrives:
await ramp.confirmCryptoReceived(order.id, { txId: "..." });
// → the engine pays out fiat via the provider automatically.
// If the provider can't pay out, it emits "payout:required" so you can do it
// your way, then call ramp.confirmPayoutSent(order.id).
```

## CosmosClient: one client for everything

Configuring `CosmosRamp` + `MercadoPagoProvider` + `EtherfuseClient` + `KoyweClient` + SEP helpers separately means repeating setup and juggling imports. `CosmosClient` wires all of it from one config object and exposes each piece as a property:

```ts
import { CosmosClient } from "cosmos-providers";

const cosmos = new CosmosClient({
  mercadopago: { accounts: { ARS: { accessToken: process.env.MP_AR_ACCESS_TOKEN!, sandbox: true } } },
  etherfuse: { apiKey: process.env.ETHERFUSE_API_KEY!, environment: "sandbox" },
  koywe: { clientId: process.env.KOYWE_CLIENT_ID!, secret: process.env.KOYWE_SECRET!, environment: "sandbox" },
  oracle: { apiKey: process.env.COINGECKO_API_KEY }, // optional
  settlement: async ({ wallet, amount, asset }) => ({ txId: await myWallet.transfer(asset, amount, wallet) }),
});

cosmos.ramp;         // CosmosRamp, wired to the mercadopago provider above
cosmos.mercadopago;  // MercadoPagoProvider, for createPaymentLink/createPixCharge directly
cosmos.etherfuse;    // EtherfuseClient
cosmos.koywe;        // KoyweClient
cosmos.sep;          // { fetchStellarToml, authenticateSep10, startDeposit, ... }
```

Pass only the pieces you need — `cosmos.ramp` is only built when at least one payment provider is configured, and `cosmos.sep` is always available even with an empty config (see the [SEP section](#sep-1--sep-10--sep-24--any-sep-compliant-anchor)).

## Custom providers

Wrap any payment API into a fully working provider — payment links, QRs, status normalization and webhooks included — without implementing `PaymentProvider` by hand. You supply the raw API calls; the responses are adapted to the Cosmos format automatically:

```ts
import { createCustomProvider } from "cosmos-providers";

const acme = createCustomProvider({
  name: "acme",
  currencies: ["ARS"],

  // Raw API calls — return the provider response as-is.
  createCharge: (req) => acmeApi.post("/charges", { amount: req.amount, ref: req.reference }),
  getCharge: (id) => acmeApi.get(`/charges/${id}`),
  createPayout: (req) => acmeApi.post("/payouts", req), // optional

  // Map provider statuses onto: pending | approved | rejected | refunded | canceled | expired.
  // A big alias table is built in ("paid"/"succeeded" → approved, ...); unknown statuses
  // resolve to "pending" — never to a false approval.
  statusMap: { ok_dale: "approved" },

  // Webhooks: HMAC-SHA256 out of the box, or bring your own verify/parse.
  webhook: {
    hmac: { secret: process.env.ACME_WEBHOOK_SECRET, header: "x-acme-signature" },
    chargeIdPaths: ["data.id"], // where the payment id lives (this is the default)
  },
});

const ramp = new CosmosRamp({ providers: [acme], /* ... */ });
```

Common response fields (`checkout_url`, `init_point`, `payment_url`, `qr_code`, `qr_code_base64`, `transaction_amount`, `external_reference`, nested `data`/`payment` objects...) are auto-mapped. For unusual shapes, take full control with `adapt`:

```ts
createCustomProvider({
  // ...
  adapt: {
    charge: (raw) => ({ id: raw.tx.id, link: raw.tx.hosted_page }),
    chargeState: (raw) => ({ status: raw.tx.phase, amount: raw.tx.cents / 100 }),
  },
});
```

Whatever the adapters return is still normalized and validated (a charge without a link/QR/deposit fails fast at creation), so `ramp.handleWebhook` and `order.charge.link` behave identically across built-in and custom providers.

## Emitting your own webhooks

Get notified on your backend(s) whenever an order moves:

```ts
const ramp = new CosmosRamp({
  // ...
  webhooks: {
    endpoints: [{ url: "https://myapp.com/hooks/cosmos", secret: process.env.HOOK_SECRET }],
  },
});
```

Every delivery is signed (`x-cosmos-signature: t=...,v1=...`). Verify it on the receiving end:

```ts
import { verifyCosmosSignature } from "cosmos-providers";

const ok = await verifyCosmosSignature(rawBody, req.get("x-cosmos-signature"), secret);
```

Events: `order.created`, `payment.approved`, `payment.rejected`, `payment.mismatch`, `settlement.released`, `settlement.failed`, `payout.required`, `order.completed`.

## Persistence

By default orders live in memory (fine for dev). In production, implement the small `OrderStore` interface (5 methods) over your database and pass it as `store`.

```ts
const ramp = new CosmosRamp({ store: new MyPostgresStore(), /* ... */ });
```

## Safety model

- Webhook bodies are never trusted: the engine re-fetches the payment from the provider API before settling.
- The paid amount must match the quoted amount (± `defaults.amountTolerance`).
- Duplicate webhooks are idempotent — an order settles once.
- If your settlement throws, the order stays in `"settling"`; retry with `ramp.retrySettlement(orderId)`.

## Standalone PIX QR codes

Generate and parse PIX BR Codes (EMV "copia e cola") without any API:

```ts
import { Pix } from "cosmos-providers";

const qr = Pix.create({
  pixKey: "payments@mycompany.com.br",
  merchantName: "My Company",
  merchantCity: "Sao Paulo",
  amount: 99.9,
});

await qr.toDataURL(); // PNG data URL for <img src>
qr.toString();        // "copia e cola" payload
Pix.parse("00020126..."); // decode + validate any BR Code
```

## Etherfuse client (PIX/SPEI ramp API)

The package also ships a full client for the [Etherfuse](https://docs.etherfuse.com) ramp API (BRL·PIX and MXN·SPEI against Solana, Stellar, Base, Polygon, Monad). Unlike `MercadoPagoProvider` (which only collects fiat — the crypto leg is your own `settlement`), Etherfuse moves the crypto itself, so it's a standalone client rather than a `PaymentProvider`:

```ts
import { EtherfuseClient } from "cosmos-providers";

const client = new EtherfuseClient({ apiKey: process.env.ETHERFUSE_API_KEY!, environment: "sandbox" });

const quote = await client.quotes.create({ /* ... */ });
const receipt = await quote.createOrder({ bankAccountId: "...", publicKey: "WALLET" });
const qr = receipt.createPixQr();
```

**Don't hardcode the target asset.** Etherfuse's onramp delivers one of its own tokenized stablebonds (CETES for MXN, TESOURO for BRL), not raw USDC, and which mint is "active" for a given chain rotates over time. Resolve it live instead:

```ts
const catalog = await client.lookup.stablebonds(); // public, no API key needed
```

Etherfuse webhook verification (Node-only) lives in the `cosmos-providers/webhooks` subpath. See [`examples/full-flow.ts`](./examples/full-flow.ts) for the complete flow across every supported chain, including automatic Stellar trustline setup.

## Koywe client (ARS/CLP/MXN/COP/PEN/BRL ↔ USDC on Stellar)

A dependency-free client for the [Koywe](https://docs-crypto.koywe.com) ramp API. Like Etherfuse, Koywe delivers USDC directly to a Stellar address as part of the order, so it's exposed as a standalone client:

```ts
import { KoyweClient } from "cosmos-providers";

const koywe = new KoyweClient({
  clientId: process.env.KOYWE_CLIENT_ID!,
  secret: process.env.KOYWE_SECRET!,
  environment: "sandbox", // or "production" — picks the matching base URL
  usdcIssuer: process.env.PUBLIC_USDC_ISSUER,
});

// On-ramp: ARS -> USDC on Stellar
const providers = await koywe.getPaymentProviders("ARS"); // WIREAR (CVU), QRI-AR (QR)...
const quote = await koywe.getQuote({ ramp: "onramp", fiatCurrency: "ARS", amount: "10000", paymentMethodId: providers[0].id });
const order = await koywe.createOnRampOrder({ quoteId: quote.id, stellarAddress: "USER_STELLAR_ADDRESS" });

order.deposit?.cvu;      // WIREAR: CVU/alias to transfer to
order.interactiveUrl;    // QRI/Khipu: hosted checkout URL instead

// Off-ramp: USDC -> ARS to a registered bank account
const account = await koywe.createBankAccount({ email, accountNumber, countryCode: "AR", currencySymbol: "ARS" });
const offQuote = await koywe.getQuote({ ramp: "offramp", fiatCurrency: "ARS", amount: "100" });
const offOrder = await koywe.createOffRampOrder({ quoteId: offQuote.id, bankAccountId: account.id });
// user sends USDC to offOrder.depositAddress, then:
await koywe.submitTxHash(offOrder.id, stellarTxHash);
```

Stellar addresses are validated locally (a from-scratch `StrKey` check — no `@stellar/stellar-sdk` dependency) before ever reaching the API. Poll orders with `koywe.getOrder(id)` (or `getOrderByExternalId` after a hosted redirect); delegated KYC lives in `createAccount` + `checkAccount`.

## SEP-1 / SEP-10 / SEP-24 — any SEP-compliant anchor

Composable, framework-agnostic functions for the Stellar Ecosystem Proposals that cover discovery → authentication → the hosted deposit/withdraw flow. Not tied to Koywe or Etherfuse — point them at any anchor's domain (a reference [test anchor](https://testanchor.stellar.org), Vibrant, Settle, your own SEP-24 server...):

```ts
import { fetchStellarToml, authenticateSep10, startDeposit, getSep24Transaction } from "cosmos-providers";

// 1. SEP-1: discover the anchor's endpoints.
const toml = await fetchStellarToml("testanchor.stellar.org");

// 2. SEP-10: prove control of the account. The library never touches private
//    keys — bring your own signer (a server-side Keypair, Freighter...).
const jwt = await authenticateSep10({
  webAuthEndpoint: toml.WEB_AUTH_ENDPOINT,
  account: "USER_STELLAR_ADDRESS",
  sign: (challengeXdr, networkPassphrase) => myWallet.signTransaction(challengeXdr, networkPassphrase),
});

// 3. SEP-24: kick off a deposit; open `url` for the user's hosted KYC/amount entry.
const { url, id } = await startDeposit({
  transferServer: toml.TRANSFER_SERVER_SEP0024,
  jwt,
  assetCode: "USDC",
  account: "USER_STELLAR_ADDRESS",
});

// 4. Poll until it settles.
const tx = await getSep24Transaction({ transferServer: toml.TRANSFER_SERVER_SEP0024, jwt, id });
tx.status; // "completed" | "pending_user_transfer_start" | ... — see SEP24_TERMINAL_STATUSES
```

`startWithdraw` mirrors `startDeposit` for the Stellar → fiat direction. This covers SEP-1/10/24 (anchor discovery, auth, and the interactive flow that most anchors and wallets build against) — SEP-6/12/31/38 (programmatic transfers, dedicated KYC, direct fiat payments, and quotes) aren't implemented yet.

Or reach these same helpers off a `CosmosClient` with no providers configured — see [CosmosClient](#cosmosclient-one-client-for-everything):

```ts
const { fetchStellarToml, authenticateSep10 } = new CosmosClient({}).sep;
```

## Standard identifiers: Chain, Asset, FiatCurrency, Country

Every provider/client in this library shares one set of identifiers instead of scattering raw string literals — `Chain.Stellar` instead of `"stellar"`, `Asset.USDC` instead of `"USDC"`. A typo becomes a compile error instead of a silent 404:

```ts
import { Chain, Asset, FiatCurrency, Country } from "cosmos-providers";

Chain.Stellar;       // "stellar" — also: Solana, Base, Polygon, Monad
Asset.USDC;          // "USDC" — also: USDT, DAI, BTC, ETH, SOL, XLM, and Etherfuse's
                     // own stablebonds: CETES, TESOURO, CARN, JOGO
FiatCurrency.ARS;    // "ARS" — also: BRL, MXN, CLP, COP, PEN, UYU
Country.AR;          // "AR" — also: BR, MX, CL, CO, PE, UY
```

Each is a frozen const object that also works as a type (`function f(c: Chain) {}` and `f(Chain.Stellar)` both type-check) — a `Chain` **is** the string `"stellar"` at runtime, so this is purely a typed front door: existing code that already passes plain strings keeps working unchanged. Stablebond addresses (which mint on which chain) are deliberately **not** baked into `Asset` — resolve those at runtime from `client.lookup.stablebonds()` or `client.assets.list()`, never hardcode them (see the [Etherfuse client](#etherfuse-client-pixspei-ramp-api) section).

## Errors

| Error | Meaning |
|---|---|
| `ProviderError` | A provider API call failed (`.provider`, `.status`, `.body`) |
| `OracleError` | CoinGecko couldn't price the pair |
| `SettlementError` | The crypto/fiat leg failed to move |
| `WebhookSignatureError` | Invalid webhook signature |
| `CosmosError` | Base class for all of the above |
| `KoyweError` | A Koywe API call failed (`.code`, `.statusCode`) |
| `SepError` | A SEP-1/10/24 call failed (`.sep`, `.statusCode`) |

## Examples

Every example in [`examples/`](./examples) is standalone and runnable — the snippets throughout this README are excerpts of these files:

```bash
npm run flow:mercadopago:link   # Mercado Pago payment link
npm run flow:mercadopago:pix    # Mercado Pago PIX (needs a real production BRL account)
npm run flow                    # Etherfuse, every supported chain
npm run flow:koywe              # Koywe on-ramp + off-ramp + KYC
npm run flow:sep                # SEP-1/10/24 against the public test anchor
npm run flow:all                # everything above, one after another
```

## Scripts

```bash
npm run build      # tsup → dist/ (ESM + CJS + .d.ts)
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## License

MIT
