/**
 * WebSocket gateway for live order events.
 *
 * Flow: POST /ramp/ws-api-token → single-use token (expires in 30s) →
 * wss://.../ramp/ws?token=... (query param because the browser can't set
 * Authorization on the upgrade). Every `order_updated` frame is re-read via REST
 * to get the authoritative status before emitting the event.
 */

import { Routes } from "@/atoms/constants";
import { EtherfuseError } from "@/atoms/errors";
import type { EtherfuseClient } from "@/client/EtherfuseClient";
import type { Order } from "@/molecules/Order";

/** Minimal subset of the WebSocket interface (DOM or `ws` package). */
export interface WebSocketLike {
  addEventListener(type: string, listener: (event: never) => void): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

export type WebSocketConstructorLike = new (url: string) => WebSocketLike;

export interface OrderUpdatedPayload {
  /** Id of the order that changed, as it came in the WebSocket frame. */
  orderId: string;
  /** Order re-read via REST; `null` if hydration failed or is disabled. */
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

  /** `true` if the socket is open (`readyState === 1`, `OPEN` in the WebSocket spec). */
  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === 1;
  }

  /** Opens the connection to the live update stream. */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.#destroyed = false;

    const WS = (this.#client.options.webSocket ??
      (globalThis as { WebSocket?: unknown }).WebSocket) as WebSocketConstructorLike | undefined;
    if (!WS) {
      throw new EtherfuseError(
        "No WebSocket implementation found. On Node < 22, pass `webSocket: WebSocket` from the 'ws' package in the client options.",
      );
    }

    // Single-use token, expires in 30s: requested right before connecting.
    const tokenResponse = await this.#client.rest.post<{ token?: string } | string>(
      Routes.wsToken(),
    );
    const token =
      typeof tokenResponse === "string" ? tokenResponse : (tokenResponse?.token ?? "");
    if (!token) throw new EtherfuseError("The API did not return a WebSocket token.");

    const wsBase = this.#client.rest.baseUrl.replace(/^http/, "ws");
    const url = `${wsBase}${Routes.wsGateway()}?token=${encodeURIComponent(token)}`;

    const socket = new WS(url);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#reconnectAttempts = 0;
      this.#client.emit("debug", "[WS] connected");
      this.#client.emit("ready");
    });

    socket.addEventListener("message", (event: { data?: unknown }) => {
      void this.#handleMessage(event?.data);
    });

    socket.addEventListener("error", () => {
      this.#client.emit("debug", "[WS] socket error");
    });

    socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
      this.#socket = null;
      this.#client.emit("disconnect", { code: event?.code, reason: event?.reason });
      this.#scheduleReconnect();
    });
  }

  /** Closes the connection and disables automatic reconnection. */
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
        /* non-JSON frame: emitted as-is */
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
        new EtherfuseError("WebSocket reconnection abandoned after 10 attempts."),
      );
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    this.#client.emit("debug", `[WS] retry ${attempt} in ${delay}ms`);
    this.#reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => this.#client.emit("error", error as Error));
    }, delay);
  }
}
