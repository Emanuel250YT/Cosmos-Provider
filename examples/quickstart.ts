/**
 * Quickstart: sell USDC via Mercado Pago with an automatic release.
 *
 * Run with: npx tsx examples/quickstart.ts
 * Env vars: MP_AR_ACCESS_TOKEN and/or MP_BR_ACCESS_TOKEN in .env
 *           MP_AR_WEBHOOK_SECRET / MP_BR_WEBHOOK_SECRET (optional, verifies the x-signature header)
 */

import { CosmosRamp, CoinGeckoOracle, MercadoPagoProvider, FiatCurrency, Asset } from "../src/index";
import { randomArsAmount, randomBrlAmount } from "./helpers/random";
import { printQr } from "./helpers/qr";

const arToken = process.env.MP_AR_ACCESS_TOKEN;
const brToken = process.env.MP_BR_ACCESS_TOKEN;
const accessToken = arToken || brToken;
if (!accessToken) {
  console.log("Skipped: set MP_AR_ACCESS_TOKEN or MP_BR_ACCESS_TOKEN in .env to run this example.");
  process.exit(0);
}
const currency = arToken ? FiatCurrency.ARS : FiatCurrency.BRL;
const webhookSecret = arToken ? process.env.MP_AR_WEBHOOK_SECRET : process.env.MP_BR_WEBHOOK_SECRET;

const ramp = new CosmosRamp({
  providers: [
    new MercadoPagoProvider({
      accessToken,
      webhookSecret,
      notificationUrl: "https://myapp.com/webhooks/mercadopago",
      // Explicit, not inferred from the token — see README, "Sandbox vs. production".
      sandbox: true,
    }),
  ],
  oracle: new CoinGeckoOracle({ apiKey: process.env.COINGECKO_API_KEY }), // key optional
  // Replace with your real transfer (custodial API, signer, exchange...).
  settlement: async ({ wallet, amount, asset }) => {
    console.log(`→ releasing ${amount} ${asset} to ${wallet}`);
    return { txId: "simulated-tx" };
  },
});

async function main() {
  // Build the payment: the CoinGecko rate + your spread are locked here.
  const order = await ramp.onramp({
    provider: "mercadopago",
    amount: currency === FiatCurrency.ARS ? randomArsAmount() : randomBrlAmount(),
    currency,
    asset: Asset.USDC,
    spread: 0.02, // 2% margin
    wallet: "USER_WALLET_ADDRESS",
    method: "link",
    description: "Buy USDC",
  });

  console.log("Pay here:   ", order.charge?.link);
  console.log("Rate:       ", order.quote.rate, "→ effective", order.quote.effectiveRate);
  console.log("USDC to send:", order.quote.cryptoAmount);
  await printQr(order.charge?.qr ?? order.charge?.link, "Payment link QR");

  // From here on, everything is automatic: when Mercado Pago notifies the
  // payment (see examples/mercadopago/webhook-server.ts), the engine verifies
  // it, checks the amount, and calls `settlement` to release the USDC.
}

main().catch(console.error);
