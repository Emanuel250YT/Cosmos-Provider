/** Molecule: Webhook — endpoint registrado para recibir eventos firmados. */

import type { APIWebhook } from "@/types/index";
import { Base } from "@/molecules/Base";

export class Webhook extends Base<APIWebhook> {
  get id(): string | undefined {
    return this.raw.webhookId;
  }

  get url(): string | undefined {
    return this.raw.url;
  }

  /**
   * Secreto HMAC (base64). ¡Solo está presente en la respuesta de creación!
   * Guárdalo de forma segura: no vuelve a devolverse.
   */
  get secret(): string | undefined {
    return this.raw.secret;
  }

  delete(): Promise<unknown> {
    if (!this.id) throw new Error("Este webhook no tiene webhookId.");
    return this.client.webhooks.delete(this.id);
  }
}
