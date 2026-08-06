import { describe, expect, it } from "vitest";
import { Pix, PixQr } from "@/molecules/Pix";
import { PixError } from "@/atoms/errors";

const BASE = {
  pixKey: "cosmos@exemplo.com.br",
  merchantName: "Cosmos Pagamentos",
  merchantCity: "São Paulo",
};

describe("Pix.payload", () => {
  it("generates a BR Code with a valid CRC", () => {
    const payload = Pix.payload({ ...BASE, amount: 150.5, txid: "COSMOS123" });
    expect(Pix.validate(payload)).toBe(true);
    expect(payload.startsWith("000201")).toBe(true); // Payload Format Indicator
    expect(payload).toContain("br.gov.bcb.pix");
    expect(payload).toContain("5303986"); // BRL currency code
    expect(payload).toContain("5802BR");
  });

  it("formats the amount with 2 decimals", () => {
    const parsed = Pix.parse(Pix.payload({ ...BASE, amount: 99.9 }));
    expect(parsed.amount).toBe("99.90");
    expect(Pix.parse(Pix.payload({ ...BASE, amount: "150" })).amount).toBe("150.00");
  });

  it("omits the amount when not specified (open-amount QR)", () => {
    const parsed = Pix.parse(Pix.payload(BASE));
    expect(parsed.amount).toBeUndefined();
  });

  it("normalizes diacritics and truncates name (25) and city (15)", () => {
    const parsed = Pix.parse(
      Pix.payload({
        pixKey: "a@b.com",
        merchantName: "Ñandú Comércio Eletrônico Ltda ME",
        merchantCity: "Florianópolis SC Brasil",
      }),
    );
    expect(parsed.merchantName).toBe("Nandu Comercio Eletronico");
    expect(parsed.merchantName!.length).toBeLessThanOrEqual(25);
    expect(parsed.merchantCity).toBe("Florianopolis S");
    expect(parsed.merchantCity!.length).toBeLessThanOrEqual(15);
  });

  it("uses '***' as the default txid", () => {
    expect(Pix.parse(Pix.payload(BASE)).txid).toBe("***");
  });

  it("sanitizes the txid to alphanumeric, max 25 chars", () => {
    const parsed = Pix.parse(Pix.payload({ ...BASE, txid: "PEDIDO-42/ÑOÑO!con-mucho-texto-extra" }));
    expect(parsed.txid).toMatch(/^[A-Za-z0-9*]{1,25}$/);
  });

  it("includes the description when passed", () => {
    const parsed = Pix.parse(Pix.payload({ ...BASE, description: "Pedido #42" }));
    expect(parsed.description).toBe("Pedido #42");
  });

  it("throws PixError with invalid data", () => {
    expect(() => Pix.payload({ ...BASE, pixKey: " " })).toThrow(PixError);
    expect(() => Pix.payload({ ...BASE, merchantName: "  " })).toThrow(PixError);
    expect(() => Pix.payload({ ...BASE, merchantCity: "" })).toThrow(PixError);
    expect(() => Pix.payload({ ...BASE, amount: -5 })).toThrow(PixError);
    expect(() => Pix.payload({ ...BASE, amount: "abc" })).toThrow(PixError);
  });
});

describe("Pix.parse / validate", () => {
  it("does a full roundtrip", () => {
    const qr = Pix.create({ ...BASE, amount: 150.5, txid: "COSMOS123", description: "Pedido" });
    const parsed = qr.parse();
    expect(parsed).toMatchObject({
      pixKey: BASE.pixKey,
      merchantName: "Cosmos Pagamentos",
      merchantCity: "Sao Paulo",
      amount: "150.50",
      txid: "COSMOS123",
      currency: "986",
      countryCode: "BR",
      valid: true,
    });
  });

  it("detects a corrupted CRC", () => {
    const payload = Pix.payload(BASE);
    const corrupted = payload.slice(0, -4) + "0000";
    expect(Pix.validate(corrupted)).toBe(false);
    expect(Pix.parse(corrupted).valid).toBe(false);
  });

  it("rejects strings that are not BR Codes", () => {
    expect(Pix.validate("")).toBe(false);
    expect(Pix.validate("hola")).toBe(false);
    expect(Pix.validate("1234567890")).toBe(false);
  });
});

describe("Pix.fromCode", () => {
  it("wraps a valid copy-and-paste code", () => {
    const payload = Pix.payload({ ...BASE, txid: "ABC" });
    const qr = Pix.fromCode(payload);
    expect(qr).toBeInstanceOf(PixQr);
    expect(qr.parse().txid).toBe("ABC");
  });

  it("rejects codes with an invalid CRC unless validate:false", () => {
    const bad = Pix.payload(BASE).slice(0, -4) + "0000";
    expect(() => Pix.fromCode(bad)).toThrow(PixError);
    expect(Pix.fromCode(bad, { validate: false }).payload).toBe(bad);
  });

  it("rejects empty codes", () => {
    expect(() => Pix.fromCode("  ")).toThrow(PixError);
  });
});

describe("PixQr render", () => {
  const qr = Pix.create({ ...BASE, amount: 10 });

  it("generates a PNG data URL", async () => {
    const url = await qr.toDataURL();
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it("generates SVG", async () => {
    const svg = await qr.toSVG({ width: 200 });
    expect(svg).toContain("<svg");
  });

  it("toString returns the payload (copy-and-paste code)", () => {
    expect(qr.toString()).toBe(qr.payload);
    expect(String(qr)).toContain("br.gov.bcb.pix");
  });
});
