/**
 * WebSocket gateway for live order events.
 *
 * Flujo: POST /ramp/ws-api-token → token de un solo uso (expira en 30 s) →
 * wss://.../ramp/ws?token=... (query param porque el navegador no puede poner
 * Authorization en el upgrade). Cada frame `order_updated` se re-lee vía REST
 * para obtener el estado autoritativo antes de emitir el evento.
 */

import { Routes } from "@/atoms/constants";
import { EtherfuseError } from "@/atoms/errors";
import type { EtherfuseClient } from "@/client/EtherfuseClient";
import type { Order } from "@/molecules/Order";

/** Subconjunto mínimo de la interfaz WebSocket (DOM o paquete `ws`). */
export interface WebSocketLike {
  addEventListener(type: string, listener: (event: never) => void): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

export type WebSocketConstructorLike = new (url: string) => WebSocketLike;

export interface OrderUpdatedPayload {
  orderId: string;
  /** Orden re-leída vía REST; `null` si la hidratación falló o está desactivada. */
  order: Order | null;
}

export class WebSocketManager {
  #client: EtherfuseClient;
  #socket: WebSocketLike | null = null;
  #destroyed = false;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: EtherfuseClient) {
    this.#client = client;
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === 1;
  }

  /** Abre la conexión al stream de actualizaciones en vivo. */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.#destroyed = false;

    const WS = (this.#client.options.webSocket ??
      (globalThis as { WebSocket?: unknown }).WebSocket) as WebSocketConstructorLike | undefined;
    if (!WS) {
      throw new EtherfuseError(
        "No hay implementación de WebSocket. En Node < 22 pasa `webSocket: WebSocket` del paquete 'ws' en las opciones del cliente.",
      );
    }

    // Token de un solo uso, expira en 30 s: se pide justo antes de conectar.
    const tokenResponse = await this.#client.rest.post<{ token?: string } | string>(
      Routes.wsToken(),
    );
    const token =
      typeof tokenResponse === "string" ? tokenResponse : (tokenResponse?.token ?? "");
    if (!token) throw new EtherfuseError("La API no devolvió un token de WebSocket.");

    const wsBase = this.#client.rest.baseUrl.replace(/^http/, "ws");
    const url = `${wsBase}${Routes.wsGateway()}?token=${encodeURIComponent(token)}`;

    const socket = new WS(url);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#reconnectAttempts = 0;
      this.#client.emit("debug", "[WS] conectado");
      this.#client.emit("ready");
    });

    socket.addEventListener("message", (event: { data?: unknown }) => {
      void this.#handleMessage(event?.data);
    });

    socket.addEventListener("error", () => {
      this.#client.emit("debug", "[WS] error de socket");
    });

    socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
      this.#socket = null;
      this.#client.emit("disconnect", { code: event?.code, reason: event?.reason });
      this.#scheduleReconnect();
    });
  }

  /** Cierra la conexión y desactiva la reconexión automática. */
  destroy(): void {
    this.#destroyed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#socket?.close(1000, "client destroy");
    this.#socket = null;
  }

  async #handleMessage(data: unknown): Promise<void> {
    let payload: unknown = data;
    if (typeof data === "string") {
      try {
        payload = JSON.parse(data);
      } catch {
        /* frame no-JSON: se emite crudo */
      }
    }
    this.#client.emit("raw", payload);

    const record = (payload ?? {}) as Record<string, unknown>;
    const type = record["type"] ?? record["event"];
    const orderId =
      (record["orderId"] as string | undefined) ??
      (record["order_id"] as string | undefined) ??
      ((record["data"] as Record<string, unknown> | undefined)?.["orderId"] as
        | string
        | undefined);

    const isOrderEvent =
      type === "order_updated" || type === "orderUpdated" || (type === undefined && !!orderId);

    if (isOrderEvent && orderId) {
      let order: Order | null = null;
      if (this.#client.options.hydrateEvents !== false) {
        try {
          order = await this.#client.orders.fetch(orderId);
        } catch (error) {
          this.#client.emit("error", error as Error);
        }
      }
      this.#client.emit("orderUpdated", { orderId, order });
    }
  }

  #scheduleReconnect(): void {
    if (this.#destroyed) return;
    const attempt = ++this.#reconnectAttempts;
    if (attempt > 10) {
      this.#client.emit(
        "error",
        new EtherfuseError("Reconexión de WebSocket abandonada tras 10 intentos."),
      );
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    this.#client.emit("debug", `[WS] reintento ${attempt} en ${delay}ms`);
    this.#reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => this.#client.emit("error", error as Error));
    }, delay);
  }
}
