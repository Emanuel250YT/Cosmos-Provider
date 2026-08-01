/**
 * Ejemplo frontend (React): mostrar un QR PIX y tipos de cambio.
 *
 * En frontend NUNCA expongas tu API key de Etherfuse: las órdenes se crean en
 * tu backend y el frontend solo recibe el código "copia e cola". La Lookup
 * API es pública, así que LookupClient sí puede usarse directo en el browser.
 */

import { useEffect, useState } from "react";
import { Pix, LookupClient } from "cosmos-providers";

const lookup = new LookupClient();

export function PixCheckout({ pixCode }: { pixCode: string }) {
  const [qrUrl, setQrUrl] = useState<string>();
  const [rate, setRate] = useState<string>();

  useEffect(() => {
    // El backend creó la orden con Etherfuse y nos pasó el copia-e-cola:
    Pix.fromCode(pixCode, { validate: false }).toDataURL({ width: 280 }).then(setQrUrl);
    lookup.usdToBrl().then((pair) => setRate(pair?.rate));
  }, [pixCode]);

  const parsed = Pix.parse(pixCode);

  return (
    <div>
      <h2>Paga con PIX</h2>
      {qrUrl && <img src={qrUrl} alt="QR PIX" />}
      <p>
        {parsed.merchantName} — R$ {parsed.amount}
      </p>
      {rate && <p>1 USD ≈ R$ {rate}</p>}
      <button onClick={() => navigator.clipboard.writeText(pixCode)}>
        Copiar código PIX
      </button>
    </div>
  );
}

/** También puedes generar QRs de cobro propios, sin backend: */
export function StaticPixQr() {
  const [svg, setSvg] = useState<string>();

  useEffect(() => {
    Pix.create({
      pixKey: "cobros@miempresa.com.br",
      merchantName: "Mi Empresa",
      merchantCity: "Sao Paulo",
      amount: 99.9,
      txid: "PEDIDO42",
    })
      .toSVG({ width: 280 })
      .then(setSvg);
  }, []);

  return svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : null;
}
