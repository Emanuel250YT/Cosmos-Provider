/**
 * QR rendering for `cosmos-providers/react`'s <QRCode src=... /> prop.
 *
 * `qrcode` is isomorphic (canvas in the browser, `pngjs` in Node), but
 * pre-rendering here — server-side, right after you already hold the
 * payload from a provider response — avoids a second client-side render
 * pass and lets `<QRCode>` paint immediately with `src`.
 */

import QRCodeLib from "qrcode";

export interface QrRenderOptions {
  width?: number;
  margin?: number;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  color?: { dark?: string; light?: string };
}

/** Renders a `data:image/png;base64,...` URL for the given payload. */
export function renderQrDataUrl(payload: string, options: QrRenderOptions = {}): Promise<string> {
  return QRCodeLib.toDataURL(payload, {
    width: options.width ?? 320,
    margin: options.margin ?? 2,
    errorCorrectionLevel: options.errorCorrectionLevel ?? "M",
    color: options.color,
  });
}

/** Renders scalable SVG markup for the given payload. */
export function renderQrSvg(payload: string, options: QrRenderOptions = {}): Promise<string> {
  return QRCodeLib.toString(payload, {
    type: "svg",
    width: options.width,
    margin: options.margin ?? 2,
    errorCorrectionLevel: options.errorCorrectionLevel ?? "M",
    color: options.color,
  }) as Promise<string>;
}
