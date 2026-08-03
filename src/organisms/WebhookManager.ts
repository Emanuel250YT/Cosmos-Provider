/** Organism: WebhookManager — `client.webhooks` (gestión de endpoints). */

import { Routes } from "@/atoms/constants";
import { Webhook } from "@/molecules/Webhook";
import type { APIWebhook, CreateWebhookOptions } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class WebhookManager extends BaseManager {
  /**
   * Registra un webhook. La respuesta incluye `secret` (base64) UNA sola vez:
   * guárdalo para verificar firmas con `cosmos-providers/webhooks`.
   */
  async create(options: CreateWebhookOptions): Promise<Webhook> {
    const raw = await this.rest.post<APIWebhook>(Routes.webhook(), options);
    return new Webhook(this.client, raw);
  }

  /** Un endpoint de webhook por id. La respuesta NO trae `secret` (solo se ve una vez, al crear). */
  async fetch(webhookId: string): Promise<Webhook> {
    const raw = await this.rest.get<APIWebhook>(Routes.webhookById(webhookId));
    return new Webhook(this.client, raw);
  }

  /** Lista todos los endpoints de webhook registrados. */
  async list(): Promise<Webhook[]> {
    const raw = await this.rest.get<APIWebhook[] | { items?: APIWebhook[] }>(Routes.webhooks());
    const items = Array.isArray(raw) ? raw : (raw.items ?? []);
    return items.map((w) => new Webhook(this.client, w));
  }

  /** Da de baja un endpoint de webhook. */
  delete(webhookId: string): Promise<unknown> {
    return this.rest.delete(Routes.webhookById(webhookId));
  }
}
