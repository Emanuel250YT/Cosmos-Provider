/**
 * Backend example: receive signed Etherfuse webhooks (Express).
 *
 * The (base64) secret is returned ONCE when the webhook is created:
 *   const wh = await client.webhooks.create({ url: "https://my.app/webhooks/etherfuse" });
 *   console.log(wh.secret); // store it in your secret manager
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
        console.log("Order updated:", event);
        // Re-read the order with client.orders.fetch(...) for the authoritative state.
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

app.listen(3000, () => console.log("Listening on :3000"));
