/**
 * Create a Mercado Pago PIX charge (Brazil / BRL only).
 *
 * IMPORTANT: PIX cannot be tested on sandbox/test credentials — Mercado
 * Pago only grants direct Payments API (PIX) access to real, production
 * merchant accounts. This script needs a real MP_BR_ACCESS_TOKEN and
 * creates a REAL charge (unpaid until someone actually scans the QR).
 * `MercadoPagoProvider.createPixCharge` throws immediately if you point it
 * at a sandbox account, rather than letting the API fail with a confusing
 * 401 — see examples/mercadopago-payment-link.ts for the rail that DOES
 * work in sandbox.
 *
 * Run:  npx tsx examples/mercadopago-pix.ts
 * Env:  MP_BR_ACCESS_TOKEN in .env
 */

import "dotenv/config";
import { MercadoPagoProvider, type Charge } from "../src/index";
import { isMainModule } from "./helpers/isMain";

export async function createPixChargeExample(): Promise<Charge | null> {
  const accessToken = process.env.MP_BR_ACCESS_TOKEN;
  if (!accessToken) {
    console.log("Skipped: set MP_BR_ACCESS_TOKEN in .env to run this example.");
    return null;
  }

  const mercadopago = new MercadoPagoProvider({
    accessToken,
    sandbox: false, // PIX only works with a real, production BRL account
    defaultPayerEmail: "buyer@example.com",
  });

  const charge = await mercadopago.createPixCharge({
    amount: 50,
    reference: `cosmos-demo-${Date.now()}`,
    description: "cosmos-providers demo — PIX",
  });

  console.log("PIX copia e cola:", charge.qr);
  console.log("PIX QR image (base64):", charge.qrBase64 ? "<embedded PNG>" : "n/a");
  return charge;
}

if (isMainModule(import.meta.url)) {
  createPixChargeExample().catch(console.error);
}
