/**
 * Webhook server for Mercado Pago notifications — plain Node, no framework.
 *
 * Point your Mercado Pago application's webhook URL to this endpoint
 * (e.g. https://myapp.com/webhooks/mercadopago). The engine does the rest:
 * verifies the x-signature header, re-fetches the payment, matches the
 * order, and releases the crypto through your settlement.
 *
 * Run with: npx tsx examples/mercadopago-webhook-server.ts
 */

import { createServer } from "node:http";
import { CosmosRamp, CoinGeckoOracle, MercadoPagoProvider } from "../src/index";

const ramp = new CosmosRamp({
  providers: [
    new MercadoPagoProvider({
      accessToken: process.env.MP_ACCESS_TOKEN!,
      webhookSecret: process.env.MP_WEBHOOK_SECRET,
    }),
  ],
  oracle: new CoinGeckoOracle({ apiKey: process.env.COINGECKO_API_KEY }), // key optional
  settlement: async ({ wallet, amount, asset }) => {
    console.log(`→ releasing ${amount} ${asset} to ${wallet}`);
    return { txId: "simulated-tx" };
  },
});

ramp.on("payment:approved", (order) => console.log("✓ paid:", order.id));
ramp.on("settlement:released", (order, { txId }) => console.log("✓ crypto sent:", txId));
ramp.on("order:completed", (order) => console.log("✓ completed:", order.id));

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/webhooks/mercadopago")) {
    res.writeHead(404).end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    const result = await ramp.handleWebhook("mercadopago", {
      body,
      headers: req.headers,
      url: req.url,
    });
    console.log("webhook:", result.outcome);
    res.writeHead(result.status).end();
  });
});

server.listen(3000, () => console.log("Listening on http://localhost:3000/webhooks/mercadopago"));
