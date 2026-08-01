/**
 * Ejemplo backend: recibir webhooks firmados de Etherfuse (Express).
 *
 * El secreto (base64) se obtiene UNA sola vez al crear el webhook:
 *   const wh = await client.webhooks.create({ url: "https://mi.app/webhooks/etherfuse" });
 *   console.log(wh.secret); // guárdalo en tu gestor de secretos
 */

import express from "express";
import { constructEvent, WebhookVerificationError } from "cosmos-providers/webhooks";

const app = express();
const SECRET = process.env.ETHERFUSE_WEBHOOK_SECRET!;

app.post(
  "/webhooks/etherfuse",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      const event = constructEvent(
        req.body.toString("utf8"),
        req.header("X-Signature"),
        SECRET,
      );

      if (event.type === "order_updated") {
        console.log("Orden actualizada:", event);
        // Re-lee la orden con client.orders.fetch(...) para el estado autoritativo.
      }

      res.sendStatus(200);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        res.sendStatus(401);
        return;
      }
      throw error;
    }
  },
);

app.listen(3000, () => console.log("Escuchando webhooks en :3000"));
