/**
 * Frontend example (React): render a PIX QR and exchange rates.
 *
 * NEVER expose your Etherfuse API key in the frontend: orders are created in
 * your backend and the frontend only receives the "copia e cola" code. The
 * Lookup API is public, so LookupClient CAN be used directly in the browser.
 */

import { useEffect, useState } from "react";
import { Pix, LookupClient } from "cosmos-providers";

const lookup = new LookupClient();

export function PixCheckout({ pixCode }: { pixCode: string }) {
  const [qrUrl, setQrUrl] = useState<string>();
  const [rate, setRate] = useState<string>();

  useEffect(() => {
    // The backend created the order and handed us the copia-e-cola code:
    Pix.fromCode(pixCode, { validate: false }).toDataURL({ width: 280 }).then(setQrUrl);
    lookup.usdToBrl().then((pair) => setRate(pair?.rate));
  }, [pixCode]);

  const parsed = Pix.parse(pixCode);

  return (
    <div>
      <h2>Pay with PIX</h2>
      {qrUrl && <img src={qrUrl} alt="PIX QR" />}
      <p>
        {parsed.merchantName} — R$ {parsed.amount}
      </p>
      {rate && <p>1 USD ≈ R$ {rate}</p>}
      <button onClick={() => navigator.clipboard.writeText(pixCode)}>
        Copy PIX code
      </button>
    </div>
  );
}

/** You can also generate your own static charge QRs, no backend needed: */
export function StaticPixQr() {
  const [svg, setSvg] = useState<string>();

  useEffect(() => {
    Pix.create({
      pixKey: "payments@mycompany.com.br",
      merchantName: "My Company",
      merchantCity: "Sao Paulo",
      amount: 99.9,
      txid: "ORDER42",
    })
      .toSVG({ width: 280 })
      .then(setSvg);
  }, []);

  return svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : null;
}
