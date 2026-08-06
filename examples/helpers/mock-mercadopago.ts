/**
 * Local Mercado Pago simulator for the runnable examples.
 *
 * Implements just enough of the MP REST API (in-memory, no network) so every
 * action can be executed without credentials:
 *
 * - POST /checkout/preferences   → payment link
 * - POST /v1/payments            → PIX QR payment
 * - GET  /v1/payments/{id}       → payment state
 * - POST /v1/money_transfers     → payout (offramp)
 *
 * `pay(chargeId)` simulates the user paying and returns a **signed** webhook
 * request (same x-signature scheme as real Mercado Pago), ready to feed into
 * `ramp.handleWebhook("mercadopago", ...)`.
 */

import { createHmac } from "node:crypto";
import { FiatCurrency } from "../../src/index";

interface MockPayment {
  id: number;
  status: string;
  transaction_amount: number;
  currency_id: string;
  external_reference?: string;
}

export interface SignedWebhookRequest {
  body: string;
  headers: Record<string, string>;
  query: Record<string, string>;
}

export function createMockMercadoPago(options: { webhookSecret: string }) {
  const payments = new Map<number, MockPayment>();
  const preferences = new Map<string, { amount: number; currency: string; reference?: string }>();
  let nextId = 1001;

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "POST" && url.pathname === "/checkout/preferences") {
      const id = `pref-${nextId++}`;
      preferences.set(id, {
        amount: body.items[0].unit_price,
        currency: body.items[0].currency_id,
        reference: body.external_reference,
      });
      return json({ id, init_point: `https://sandbox.mercadopago.example/checkout?pref_id=${id}` });
    }

    if (method === "POST" && url.pathname === "/v1/payments") {
      const id = nextId++;
      payments.set(id, {
        id,
        status: "pending",
        transaction_amount: body.transaction_amount,
        currency_id: FiatCurrency.BRL,
        external_reference: body.external_reference,
      });
      return json({
        id,
        point_of_interaction: {
          transaction_data: {
            qr_code: `00020126580014BR.GOV.BCB.PIX-MOCK-${id}5204000053039865802BR`,
            qr_code_base64: "",
            ticket_url: `https://sandbox.mercadopago.example/ticket/${id}`,
          },
        },
      });
    }

    const paymentMatch = url.pathname.match(/^\/v1\/payments\/(\d+)$/);
    if (method === "GET" && paymentMatch) {
      const payment = payments.get(Number(paymentMatch[1]));
      return payment ? json(payment) : json({ message: "payment not found" }, 404);
    }

    if (method === "POST" && url.pathname === "/v1/money_transfers") {
      return json({ id: nextId++, status: "approved" });
    }

    return json({ message: `mock has no route for ${method} ${url.pathname}` }, 404);
  };

  /**
   * Simulate the user paying a charge. Accepts a preference id ("pref-...")
   * or a PIX payment id. `amount` overrides the paid amount (to demo the
   * amount-mismatch protection). Returns a signed webhook request.
   */
  function pay(chargeId: string, overrides?: { amount?: number }): SignedWebhookRequest {
    let payment: MockPayment;
    if (chargeId.startsWith("pref-")) {
      const preference = preferences.get(chargeId);
      if (!preference) throw new Error(`Unknown preference ${chargeId}`);
      const id = nextId++;
      payment = {
        id,
        status: "approved",
        transaction_amount: overrides?.amount ?? preference.amount,
        currency_id: preference.currency,
        external_reference: preference.reference,
      };
      payments.set(id, payment);
    } else {
      const existing = payments.get(Number(chargeId));
      if (!existing) throw new Error(`Unknown payment ${chargeId}`);
      existing.status = "approved";
      if (overrides?.amount !== undefined) existing.transaction_amount = overrides.amount;
      payment = existing;
    }
    return signedWebhook(payment.id);
  }

  /** Build a webhook request signed exactly like real Mercado Pago does. */
  function signedWebhook(paymentId: number): SignedWebhookRequest {
    const ts = String(Math.floor(Date.now() / 1000));
    const requestId = `req-${paymentId}`;
    const manifest = `id:${paymentId};request-id:${requestId};ts:${ts};`;
    const v1 = createHmac("sha256", options.webhookSecret).update(manifest).digest("hex");
    return {
      body: JSON.stringify({ type: "payment", data: { id: paymentId } }),
      headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId },
      query: { "data.id": String(paymentId) },
    };
  }

  return { fetchImpl, pay, signedWebhook };
}
