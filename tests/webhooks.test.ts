import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  constructEvent,
  verifySignature,
  WebhookVerificationError,
} from "@/webhooks/index";

const SECRET = Buffer.from("super-secreto-de-webhook").toString("base64");

function sign(body: unknown): string {
  const digest = createHmac("sha256", Buffer.from(SECRET, "base64"))
    .update(canonicalize(body), "utf8")
    .digest("hex");
  return `sha256=${digest}`;
}

describe("canonicalize (RFC 8785 JCS)", () => {
  it("sorts keys alphabetically and strips whitespace", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts recursively in nested objects", () => {
    expect(canonicalize({ z: { y: 1, x: 2 }, a: [{ c: 1, b: 2 }] })).toBe(
      '{"a":[{"b":2,"c":1}],"z":{"x":2,"y":1}}',
    );
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("omits undefined properties and serializes null/bool/numbers", () => {
    expect(canonicalize({ a: undefined, b: null, c: true, d: 1.5 })).toBe(
      '{"b":null,"c":true,"d":1.5}',
    );
  });

  it("keeps unicode characters literal", () => {
    expect(canonicalize({ k: "ñandú" })).toBe('{"k":"ñandú"}');
  });
});

describe("verifySignature", () => {
  const body = { type: "order_updated", orderId: "abc-123", amount: "150.50" };

  it("accepts a correct signature (object)", () => {
    expect(verifySignature({ body, signature: sign(body), secret: SECRET })).toBe(true);
  });

  it("accepts the body as a raw string even with a different format", () => {
    // The body on the wire may arrive with different spacing/order: JCS normalizes it.
    const wire = JSON.stringify({ amount: "150.50", orderId: "abc-123", type: "order_updated" }, null, 2);
    expect(verifySignature({ body: wire, signature: sign(body), secret: SECRET })).toBe(true);
  });

  it("rejects incorrect signatures", () => {
    expect(verifySignature({ body, signature: "sha256=" + "0".repeat(64), secret: SECRET })).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifySignature({ body, signature: null, secret: SECRET })).toBe(false);
    expect(verifySignature({ body, signature: undefined, secret: SECRET })).toBe(false);
  });

  it("rejects a non-JSON body", () => {
    expect(verifySignature({ body: "not json", signature: sign(body), secret: SECRET })).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const tampered = { ...body, amount: "999.99" };
    expect(verifySignature({ body: tampered, signature: sign(body), secret: SECRET })).toBe(false);
  });
});

describe("constructEvent", () => {
  const body = { type: "order_updated", orderId: "abc-123" };

  it("returns the parsed event when the signature is valid", () => {
    const event = constructEvent(JSON.stringify(body), sign(body), SECRET);
    expect(event.type).toBe("order_updated");
    expect(event["orderId"]).toBe("abc-123");
  });

  it("throws WebhookVerificationError when the signature is invalid", () => {
    expect(() => constructEvent(JSON.stringify(body), "sha256=deadbeef", SECRET)).toThrow(
      WebhookVerificationError,
    );
  });
});
