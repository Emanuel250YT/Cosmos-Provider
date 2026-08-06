/**
 * Molecule: PIX (BR Code EMV® QRCPS-MPM).
 *
 * - `Pix.create(...)` builds a static payment QR from a PIX key.
 * - `Pix.fromCode(...)` wraps an existing "copia e cola" (e.g. the one
 *   Etherfuse returns on a BRL onramp order) to render it as a QR.
 * - `PixQr` renders the payload as a Data URL (PNG) or SVG, in the browser and Node.
 */

import QRCode from "qrcode";
import { crc16ccitt } from "@/atoms/crc16";
import { PixError } from "@/atoms/errors";

const PIX_GUI = "br.gov.bcb.pix";

export interface PixStaticOptions {
  /** Payee's PIX key: CPF/CNPJ, email, phone (+55...), or random key. */
  pixKey: string;
  /** Payee's name (max 25 characters; normalized to ASCII). */
  merchantName: string;
  /** Payee's city (max 15 characters; normalized to ASCII). */
  merchantCity: string;
  /** Amount in BRL. If omitted, the payer enters it manually. */
  amount?: number | string;
  /** Transaction identifier (A-Z a-z 0-9, max 25). Default: "***". */
  txid?: string;
  /** Optional message/description shown to the payer. */
  description?: string;
}

export interface ParsedPix {
  /** Original full payload. */
  payload: string;
  pixKey?: string;
  description?: string;
  merchantName?: string;
  merchantCity?: string;
  amount?: string;
  txid?: string;
  currency?: string;
  countryCode?: string;
  /** `true` if the payload's CRC is correct. */
  valid: boolean;
  /** Full top-level TLV map. */
  fields: Record<string, string>;
}

export interface PixQrImageOptions {
  /** Pixel size of the generated QR (PNG). Default: 320. */
  width?: number;
  /** Margin in modules. Default: 2. */
  margin?: number;
  /** Error correction level. Default: "M". */
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  color?: { dark?: string; light?: string };
}

/** EMV TLV field: id (2) + length (2) + value. */
function emv(id: string, value: string): string {
  if (value.length > 99) {
    throw new PixError(`EMV field ${id} exceeds 99 characters (${value.length}).`);
  }
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/** Strips diacritics and characters outside the EMV set, and trims to `max`. */
function normalizeText(value: string, max: number): string {
  const ascii = value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ascii.slice(0, max);
}

function formatAmount(amount: number | string): string {
  const num = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(num) || num <= 0) {
    throw new PixError(`Invalid PIX amount: ${String(amount)}`);
  }
  return num.toFixed(2);
}

export class Pix {
  /** Builds the "copia e cola" payload for a static PIX. */
  static payload(options: PixStaticOptions): string {
    const { pixKey } = options;
    if (!pixKey || !pixKey.trim()) throw new PixError("pixKey is required.");

    const merchantName = normalizeText(options.merchantName, 25);
    const merchantCity = normalizeText(options.merchantCity, 15);
    if (!merchantName) throw new PixError("merchantName is required.");
    if (!merchantCity) throw new PixError("merchantCity is required.");

    const txid = (options.txid ?? "***").replace(/[^A-Za-z0-9*]/g, "").slice(0, 25) || "***";

    const merchantAccount = [
      emv("00", PIX_GUI),
      emv("01", pixKey.trim()),
      options.description ? emv("02", normalizeText(options.description, 72)) : "",
    ].join("");

    const body = [
      emv("00", "01"), // Payload Format Indicator
      emv("26", merchantAccount), // Merchant Account Information (PIX)
      emv("52", "0000"), // Merchant Category Code
      emv("53", "986"), // Currency: BRL (ISO 4217)
      options.amount !== undefined ? emv("54", formatAmount(options.amount)) : "",
      emv("58", "BR"),
      emv("59", merchantName),
      emv("60", merchantCity),
      emv("62", emv("05", txid)), // Additional Data Field → txid
    ].join("");

    const withCrcTag = `${body}6304`;
    return withCrcTag + crc16ccitt(withCrcTag);
  }

  /** Creates a static PIX QR ready to render. */
  static create(options: PixStaticOptions): PixQr {
    return new PixQr(Pix.payload(options));
  }

  /**
   * Wraps an existing "copia e cola" code (e.g. the one returned by
   * Etherfuse when creating a BRL onramp order) to render it as a QR.
   */
  static fromCode(code: string, { validate = true }: { validate?: boolean } = {}): PixQr {
    const trimmed = code.trim();
    if (!trimmed) throw new PixError("The PIX code is empty.");
    if (validate && !Pix.validate(trimmed)) {
      throw new PixError(
        "The PIX code has an invalid CRC. Use { validate: false } to skip verification.",
      );
    }
    return new PixQr(trimmed);
  }

  /** Verifies the payload's CRC16. */
  static validate(code: string): boolean {
    const trimmed = code.trim();
    if (trimmed.length < 8) return false;
    const body = trimmed.slice(0, -4);
    if (!body.toUpperCase().endsWith("6304")) return false;
    return crc16ccitt(body) === trimmed.slice(-4).toUpperCase();
  }

  /** Decodes a BR Code into its main fields. */
  static parse(code: string): ParsedPix {
    const payload = code.trim();
    const fields = Pix.#tlv(payload.slice(0, -8)); // without "6304" + CRC
    const crcOk = Pix.validate(payload);

    const merchantAccount = fields["26"] ? Pix.#tlv(fields["26"]) : {};
    const additional = fields["62"] ? Pix.#tlv(fields["62"]) : {};

    return {
      payload,
      pixKey: merchantAccount["01"],
      description: merchantAccount["02"],
      merchantName: fields["59"],
      merchantCity: fields["60"],
      amount: fields["54"],
      txid: additional["05"],
      currency: fields["53"],
      countryCode: fields["58"],
      valid: crcOk,
      fields,
    };
  }

  static #tlv(data: string): Record<string, string> {
    const out: Record<string, string> = {};
    let i = 0;
    while (i + 4 <= data.length) {
      const id = data.slice(i, i + 2);
      const len = Number(data.slice(i + 2, i + 4));
      if (!Number.isFinite(len)) break;
      out[id] = data.slice(i + 4, i + 4 + len);
      i += 4 + len;
    }
    return out;
  }
}

/** A PIX payload renderable as a QR image. */
export class PixQr {
  constructor(readonly payload: string) {}

  /** Decoded fields from the payload. */
  parse(): ParsedPix {
    return Pix.parse(this.payload);
  }

  /** `image/png` Data URL — ideal for `<img src>` in the frontend. */
  toDataURL(options: PixQrImageOptions = {}): Promise<string> {
    return QRCode.toDataURL(this.payload, {
      width: options.width ?? 320,
      margin: options.margin ?? 2,
      errorCorrectionLevel: options.errorCorrectionLevel ?? "M",
      color: options.color,
    });
  }

  /** SVG markup for the QR — scalable, no canvas. */
  toSVG(options: PixQrImageOptions = {}): Promise<string> {
    return QRCode.toString(this.payload, {
      type: "svg",
      width: options.width,
      margin: options.margin ?? 2,
      errorCorrectionLevel: options.errorCorrectionLevel ?? "M",
      color: options.color,
    });
  }

  /** QR as text for printing in a terminal (useful for CLIs/back-office). */
  toTerminal(): Promise<string> {
    const options = { type: "terminal", small: true } as Parameters<typeof QRCode.toString>[1];
    return QRCode.toString(this.payload, options) as Promise<string>;
  }

  /** The "copia e cola" the payer can paste into their banking app. */
  toString(): string {
    return this.payload;
  }

  toJSON(): { payload: string } {
    return { payload: this.payload };
  }
}
