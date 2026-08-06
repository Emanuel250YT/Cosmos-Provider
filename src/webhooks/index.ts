/**
 * cosmos-providers/webhooks — verifies Etherfuse webhook signatures.
 *
 * Backend only (uses node:crypto). Etherfuse signs each webhook with
 * HMAC-SHA256 over the JSON canonicalized per RFC 8785 (JCS) and sends it in
 * the `X-Signature: sha256={hex}` header. The secret arrives in base64 when
 * the webhook is created (only once).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "@/atoms/errors";
import type { WebhookEvent } from "@/types/index";

export { WebhookVerificationError };
export type { WebhookEvent };

/** Header Etherfuse sends the signature in. */
export const SIGNATURE_HEADER = "x-signature";

/**
 * JSON canonicalization per RFC 8785 (JCS): sorted keys, no whitespace.
 * The numbers JSON.parse produces serialize exactly as JCS requires.
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
  throw new WebhookVerificationError(`Non-serializable value in payload: ${typeof value}`);
}

export interface VerifySignatureOptions {
  /** Webhook body: raw string or an already-parsed object. */
  body: string | object;
  /** Value of the `X-Signature` header (format `sha256={hex}`). */
  signature: string | null | undefined;
  /** Webhook secret, in base64 (exactly as returned by the API on creation). */
  secret: string;
}

/** Returns `true` if the signature is valid. Constant-time comparison. */
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
 * Verifies the signature and returns the parsed, typed event.
 * Throws {@link WebhookVerificationError} if the signature is invalid.
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
    throw new WebhookVerificationError("Invalid webhook signature.");
  }
  return (typeof body === "string" ? JSON.parse(body) : body) as T;
}
