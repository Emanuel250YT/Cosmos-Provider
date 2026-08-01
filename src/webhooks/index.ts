/**
 * cosmos-providers/webhooks — verificación de firmas de webhooks de Etherfuse.
 *
 * Solo backend (usa node:crypto). Etherfuse firma cada webhook con
 * HMAC-SHA256 sobre el JSON canonicalizado según RFC 8785 (JCS) y lo envía en
 * la cabecera `X-Signature: sha256={hex}`. El secreto llega en base64 al
 * crear el webhook (una sola vez).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "@/atoms/errors";
import type { WebhookEvent } from "@/types/index";

export { WebhookVerificationError };
export type { WebhookEvent };

/** Cabecera donde Etherfuse envía la firma. */
export const SIGNATURE_HEADER = "x-signature";

/**
 * Canonicalización JSON según RFC 8785 (JCS): claves ordenadas, sin espacios.
 * Los números que produce JSON.parse serializan igual que exige JCS.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item === undefined ? null : item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(",")}}`;
  }
  throw new WebhookVerificationError(`Valor no serializable en el payload: ${typeof value}`);
}

export interface VerifySignatureOptions {
  /** Cuerpo del webhook: string crudo u objeto ya parseado. */
  body: string | object;
  /** Valor de la cabecera `X-Signature` (formato `sha256={hex}`). */
  signature: string | null | undefined;
  /** Secreto del webhook, en base64 (tal cual lo devolvió la API al crearlo). */
  secret: string;
}

/** Devuelve `true` si la firma es válida. Comparación en tiempo constante. */
export function verifySignature({ body, signature, secret }: VerifySignatureOptions): boolean {
  if (!signature) return false;

  let parsed: unknown;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  } else {
    parsed = body;
  }

  const canonical = canonicalize(parsed);
  const key = Buffer.from(secret, "base64");
  const digest = createHmac("sha256", key).update(canonical, "utf8").digest("hex");
  const expected = Buffer.from(`sha256=${digest}`);
  const received = Buffer.from(signature.trim());

  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Verifica la firma y devuelve el evento parseado y tipado.
 * Lanza {@link WebhookVerificationError} si la firma no es válida.
 *
 * ```ts
 * app.post("/webhooks/etherfuse", express.raw({ type: "application/json" }), (req, res) => {
 *   const event = constructEvent(req.body.toString("utf8"), req.get("X-Signature"), secret);
 *   if (event.type === "order_updated") { ... }
 *   res.sendStatus(200);
 * });
 * ```
 */
export function constructEvent<T extends WebhookEvent = WebhookEvent>(
  body: string | object,
  signature: string | null | undefined,
  secret: string,
): T {
  if (!verifySignature({ body, signature, secret })) {
    throw new WebhookVerificationError("Firma de webhook inválida.");
  }
  return (typeof body === "string" ? JSON.parse(body) : body) as T;
}
