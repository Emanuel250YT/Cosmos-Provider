/**
 * Molecule: PIX (BR Code EMV® QRCPS-MPM).
 *
 * - `Pix.create(...)` construye un QR estático de cobro a partir de una llave PIX.
 * - `Pix.fromCode(...)` envuelve un "copia e cola" existente (p. ej. el que
 *   devuelve Etherfuse en una orden onramp BRL) para renderizarlo como QR.
 * - `PixQr` renderiza el payload como Data URL (PNG) o SVG, en navegador y Node.
 */

import QRCode from "qrcode";
import { crc16ccitt } from "@/atoms/crc16";
import { PixError } from "@/atoms/errors";

const PIX_GUI = "br.gov.bcb.pix";

export interface PixStaticOptions {
  /** Llave PIX del cobrador: CPF/CNPJ, email, teléfono (+55...) o llave aleatoria. */
  pixKey: string;
  /** Nombre del cobrador (máx. 25 caracteres; se normaliza a ASCII). */
  merchantName: string;
  /** Ciudad del cobrador (máx. 15 caracteres; se normaliza a ASCII). */
  merchantCity: string;
  /** Monto en BRL. Si se omite, el pagador lo introduce manualmente. */
  amount?: number | string;
  /** Identificador de transacción (A-Z a-z 0-9, máx. 25). Default: "***". */
  txid?: string;
  /** Mensaje/descripción opcional que ve el pagador. */
  description?: string;
}

export interface ParsedPix {
  /** Payload completo original. */
  payload: string;
  pixKey?: string;
  description?: string;
  merchantName?: string;
  merchantCity?: string;
  amount?: string;
  txid?: string;
  currency?: string;
  countryCode?: string;
  /** `true` si el CRC del payload es correcto. */
  valid: boolean;
  /** Mapa TLV completo de primer nivel. */
  fields: Record<string, string>;
}

export interface PixQrImageOptions {
  /** Píxeles del QR generado (PNG). Default: 320. */
  width?: number;
  /** Margen en módulos. Default: 2. */
  margin?: number;
  /** Nivel de corrección de errores. Default: "M". */
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  color?: { dark?: string; light?: string };
}

/** Campo TLV EMV: id (2) + longitud (2) + valor. */
function emv(id: string, value: string): string {
  if (value.length > 99) {
    throw new PixError(`El campo EMV ${id} excede 99 caracteres (${value.length}).`);
  }
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/** Quita diacríticos y caracteres fuera del set EMV, y recorta a `max`. */
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
    throw new PixError(`Monto PIX inválido: ${String(amount)}`);
  }
  return num.toFixed(2);
}

export class Pix {
  /** Construye el payload "copia e cola" de un PIX estático. */
  static payload(options: PixStaticOptions): string {
    const { pixKey } = options;
    if (!pixKey || !pixKey.trim()) throw new PixError("pixKey es obligatoria.");

    const merchantName = normalizeText(options.merchantName, 25);
    const merchantCity = normalizeText(options.merchantCity, 15);
    if (!merchantName) throw new PixError("merchantName es obligatorio.");
    if (!merchantCity) throw new PixError("merchantCity es obligatoria.");

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
      emv("53", "986"), // Moneda: BRL (ISO 4217)
      options.amount !== undefined ? emv("54", formatAmount(options.amount)) : "",
      emv("58", "BR"),
      emv("59", merchantName),
      emv("60", merchantCity),
      emv("62", emv("05", txid)), // Additional Data Field → txid
    ].join("");

    const withCrcTag = `${body}6304`;
    return withCrcTag + crc16ccitt(withCrcTag);
  }

  /** Crea un QR PIX estático listo para renderizar. */
  static create(options: PixStaticOptions): PixQr {
    return new PixQr(Pix.payload(options));
  }

  /**
   * Envuelve un código "copia e cola" ya existente (p. ej. el devuelto por
   * Etherfuse al crear una orden onramp en BRL) para renderizarlo como QR.
   */
  static fromCode(code: string, { validate = true }: { validate?: boolean } = {}): PixQr {
    const trimmed = code.trim();
    if (!trimmed) throw new PixError("El código PIX está vacío.");
    if (validate && !Pix.validate(trimmed)) {
      throw new PixError(
        "El código PIX tiene un CRC inválido. Usa { validate: false } para omitir la verificación.",
      );
    }
    return new PixQr(trimmed);
  }

  /** Verifica el CRC16 del payload. */
  static validate(code: string): boolean {
    const trimmed = code.trim();
    if (trimmed.length < 8) return false;
    const body = trimmed.slice(0, -4);
    if (!body.toUpperCase().endsWith("6304")) return false;
    return crc16ccitt(body) === trimmed.slice(-4).toUpperCase();
  }

  /** Decodifica un BR Code a sus campos principales. */
  static parse(code: string): ParsedPix {
    const payload = code.trim();
    const fields = Pix.#tlv(payload.slice(0, -8)); // sin "6304" + CRC
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

/** Un payload PIX renderizable como imagen QR. */
export class PixQr {
  constructor(readonly payload: string) {}

  /** Campos decodificados del payload. */
  parse(): ParsedPix {
    return Pix.parse(this.payload);
  }

  /** Data URL `image/png` — ideal para `<img src>` en frontend. */
  toDataURL(options: PixQrImageOptions = {}): Promise<string> {
    return QRCode.toDataURL(this.payload, {
      width: options.width ?? 320,
      margin: options.margin ?? 2,
      errorCorrectionLevel: options.errorCorrectionLevel ?? "M",
      color: options.color,
    });
  }

  /** Markup SVG del QR — escalable, sin canvas. */
  toSVG(options: PixQrImageOptions = {}): Promise<string> {
    return QRCode.toString(this.payload, {
      type: "svg",
      width: options.width,
      margin: options.margin ?? 2,
      errorCorrectionLevel: options.errorCorrectionLevel ?? "M",
      color: options.color,
    });
  }

  /** QR como texto para imprimir en terminal (útil en CLIs/back-office). */
  toTerminal(): Promise<string> {
    const options = { type: "terminal", small: true } as Parameters<typeof QRCode.toString>[1];
    return QRCode.toString(this.payload, options) as Promise<string>;
  }

  /** El "copia e cola" que el pagador puede pegar en su app bancaria. */
  toString(): string {
    return this.payload;
  }

  toJSON(): { payload: string } {
    return { payload: this.payload };
  }
}
