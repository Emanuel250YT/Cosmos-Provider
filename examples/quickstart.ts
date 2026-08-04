/**
 * Quickstart: sell USDC via Mercado Pago with an automatic release.
 *
 * Run with: npx tsx examples/quickstart.ts
 * Env vars: MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET (optional)
 */

import { CosmosRamp, CoinGeckoOracle, MercadoPagoProvider } from "../src/index";

const ramp = new CosmosRamp({
  providers: [
    new MercadoPagoProvider({
      accessToken: process.env.MP_ACCESS_TOKEN!,
      webhookSecret: process.env.MP_WEBHOOK_SECRET,
      notificationUrl: "https://myapp.com/webhooks/mercadopago",
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
    amount: 5000, // ARS
    currency: "ARS",
    asset: "USDC",
    spread: 0.02, // 2% margin
    wallet: "USER_WALLET_ADDRESS",
    method: "link",
    description: "Buy USDC",
  });

  console.log("Pay here:   ", order.charge?.link);
  console.log("Rate:       ", order.quote.rate, "→ effective", order.quote.effectiveRate);
  console.log("USDC to send:", order.quote.cryptoAmount);

  // From here on, everything is automatic: when Mercado Pago notifies the
  // payment (see examples/mercadopago-webhook-server.ts), the engine verifies
  // it, checks the amount, and calls `settlement` to release the USDC.
}

main().catch(console.error);
