"use client";

import { useEffect, useState } from "react";
import QRCodeLib from "qrcode";

export interface QRCodeProps {
  /** Raw payload to encode (PIX "copia e cola", a wallet address, a charge's `qr` string...). Generated client-side. */
  value?: string;
  /** A pre-rendered data URL or SVG markup string — pass this when the QR was generated server-side (see `cosmos-providers/react/server`) to avoid a client render pass. */
  src?: string;
  size?: number;
  margin?: number;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  color?: { dark?: string; light?: string };
  alt?: string;
  className?: string;
}

/**
 * Renders a scannable QR code. Pass `src` for a QR already rendered on the
 * server (isomorphic — see `renderQrDataUrl`/`renderQrSvg` in
 * `cosmos-providers/react/server`); pass `value` to generate it in the
 * browser instead. Never pass a secret in `value` — QR payloads render to
 * a plain image anyone with the page can read.
 */
export function QRCode({ value, src, size = 240, margin = 2, errorCorrectionLevel = "M", color, alt = "QR code", className }: QRCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(src ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (src) {
      setDataUrl(src);
      return;
    }
    if (!value) return;
    let cancelled = false;
    QRCodeLib.toDataURL(value, { width: size, margin, errorCorrectionLevel, color })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [value, src, size, margin, errorCorrectionLevel, color]);

  if (error) {
    return (
      <div
        role="alert"
        style={{
          width: size,
          maxWidth: "100%",
          aspectRatio: "1 / 1",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          padding: 8,
          boxSizing: "border-box",
          textAlign: "center",
          color: "#B91C1C",
          border: "1px solid #FCA5A5",
          borderRadius: 8,
        }}
      >
        {error}
      </div>
    );
  }

  if (!dataUrl) {
    return <div style={{ width: size, maxWidth: "100%", aspectRatio: "1 / 1", background: "#F3F4F6", borderRadius: 8 }} aria-busy="true" />;
  }

  return (
    <img
      src={dataUrl}
      alt={alt}
      width={size}
      height={size}
      className={className}
      style={{ display: "block", width: size, maxWidth: "100%", height: "auto" }}
    />
  );
}
