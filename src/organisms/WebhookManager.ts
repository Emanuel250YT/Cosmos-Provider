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

  async fetch(webhookId: string): Promise<Webhook> {
    const raw = await this.rest.get<APIWebhook>(Routes.webhookById(webhookId));
    return new Webhook(this.client, raw);
  }

  async list(): Promise<Webhook[]> {
    const raw = await this.rest.get<APIWebhook[] | { items?: APIWebhook[] }>(Routes.webhooks());
    const items = Array.isArray(raw) ? raw : (raw.items ?? []);
    return items.map((w) => new Webhook(this.client, w));
  }

  delete(webhookId: string): Promise<unknown> {
    return this.rest.delete(Routes.webhookById(webhookId));
  }
}
