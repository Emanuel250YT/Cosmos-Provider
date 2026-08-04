/**
 * Create a Mercado Pago Checkout Pro payment link.
 *
 * This is the rail to reach for by default: it works in every Mercado Pago
 * market (AR, BR, MX, CL, CO, PE, UY) and is the one that's actually usable
 * against sandbox/test credentials. PIX (Brazil's other rail) is different
 * enough — and unavailable in sandbox — that it gets its own example, see
 * examples/mercadopago/pix.ts.
 *
 * Run:  npx tsx examples/mercadopago/payment-link.ts
 * Env:  MP_AR_ACCESS_TOKEN and/or MP_BR_ACCESS_TOKEN in .env
 */

import "dotenv/config";
import { MercadoPagoProvider, FiatCurrency, type Charge } from "../../src/index";
import { isMainModule } from "../helpers/isMain";

export async function createPaymentLinkExample(): Promise<Charge | null> {
  const arToken = process.env.MP_AR_ACCESS_TOKEN;
  const brToken = process.env.MP_BR_ACCESS_TOKEN;
  const accessToken = arToken || brToken;
  if (!accessToken) {
    console.log("Skipped: set MP_AR_ACCESS_TOKEN or MP_BR_ACCESS_TOKEN in .env to run this example.");
    return null;
  }
  const currency = arToken ? FiatCurrency.ARS : FiatCurrency.BRL;

  const mercadopago = new MercadoPagoProvider({
    accessToken,
    // Hardcoded on purpose: this is a test script, and the token's prefix
    // alone can't tell sandbox and production apart (Mercado Pago issues
    // "APP_USR-..." for both real accounts and "usuario de prueba" test
    // accounts) — sandbox/production is a config decision you make in your
    // own code, not something read from .env. Flip this to `false` in your
    // own integration once you're ready to go live.
    sandbox: true,
  });

  const charge = await mercadopago.createPaymentLink({
    amount: currency === FiatCurrency.ARS ? 5_000 : 50,
    currency,
    reference: `cosmos-demo-${Date.now()}`,
    description: "cosmos-providers demo — payment link",
  });

  console.log(`Payment link (${currency}):`, charge.link);
  return charge;
}

if (isMainModule(import.meta.url)) {
  createPaymentLinkExample().catch(console.error);
}
