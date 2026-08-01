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
  it("ordena claves alfabéticamente y elimina espacios", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("ordena recursivamente en objetos anidados", () => {
    expect(canonicalize({ z: { y: 1, x: 2 }, a: [{ c: 1, b: 2 }] })).toBe(
      '{"a":[{"b":2,"c":1}],"z":{"x":2,"y":1}}',
    );
  });

  it("preserva el orden de arrays", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("omite propiedades undefined y serializa null/bool/números", () => {
    expect(canonicalize({ a: undefined, b: null, c: true, d: 1.5 })).toBe(
      '{"b":null,"c":true,"d":1.5}',
    );
  });

  it("mantiene caracteres unicode literales", () => {
    expect(canonicalize({ k: "ñandú" })).toBe('{"k":"ñandú"}');
  });
});

describe("verifySignature", () => {
  const body = { type: "order_updated", orderId: "abc-123", amount: "150.50" };

  it("acepta una firma correcta (objeto)", () => {
    expect(verifySignature({ body, signature: sign(body), secret: SECRET })).toBe(true);
  });

  it("acepta el body como string crudo aunque tenga otro formato", () => {
    // El body en el wire puede venir con espacios/orden distinto: JCS lo normaliza.
    const wire = JSON.stringify({ amount: "150.50", orderId: "abc-123", type: "order_updated" }, null, 2);
    expect(verifySignature({ body: wire, signature: sign(body), secret: SECRET })).toBe(true);
  });

  it("rechaza firmas incorrectas", () => {
    expect(verifySignature({ body, signature: "sha256=" + "0".repeat(64), secret: SECRET })).toBe(false);
  });

  it("rechaza firma ausente", () => {
    expect(verifySignature({ body, signature: null, secret: SECRET })).toBe(false);
    expect(verifySignature({ body, signature: undefined, secret: SECRET })).toBe(false);
  });

  it("rechaza body no-JSON", () => {
    expect(verifySignature({ body: "no soy json", signature: sign(body), secret: SECRET })).toBe(false);
  });

  it("rechaza si el payload fue alterado", () => {
    const tampered = { ...body, amount: "999.99" };
    expect(verifySignature({ body: tampered, signature: sign(body), secret: SECRET })).toBe(false);
  });
});

describe("constructEvent", () => {
  const body = { type: "order_updated", orderId: "abc-123" };

  it("devuelve el evento parseado si la firma es válida", () => {
    const event = constructEvent(JSON.stringify(body), sign(body), SECRET);
    expect(event.type).toBe("order_updated");
    expect(event["orderId"]).toBe("abc-123");
  });

  it("lanza WebhookVerificationError si la firma es inválida", () => {
    expect(() => constructEvent(JSON.stringify(body), "sha256=deadbeef", SECRET)).toThrow(
      WebhookVerificationError,
    );
  });
});
