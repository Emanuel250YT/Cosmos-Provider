/**
 * Atom: capa de transporte HTTP (equivalente al `REST` de discord.js).
 *
 * - Autenticación: la API key va en `Authorization` SIN prefijo `Bearer`.
 * - Reintentos con backoff exponencial para 424/429/5xx y errores de red.
 * - Isomórfica: usa `fetch` global (Node >= 18 y navegadores).
 */

import { BASE_URLS, type Environment } from "@/atoms/constants";
import { EtherfuseAPIError, EtherfuseNetworkError } from "@/atoms/errors";

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  /** Query string (los valores undefined/null se omiten). */
  query?: Record<string, QueryValue>;
  /** Cuerpo JSON. */
  body?: unknown;
  /** Cabeceras adicionales. */
  headers?: Record<string, string>;
  /** Si `false`, no se envía la API key (endpoints públicos de /lookup). */
  auth?: boolean;
  /** Anula el número de reintentos configurado para esta petición. */
  retries?: number;
}

export interface RESTOptions {
  /** API key de Etherfuse (sandbox y producción usan claves distintas). */
  apiKey?: string;
  /** `sandbox` (default) o `production`. */
  environment?: Environment;
  /** Anula la URL base derivada del environment. */
  baseUrl?: string;
  /** Implementación de fetch a usar (por defecto, la global). */
  fetch?: typeof fetch;
  /** Timeout por intento, en ms. Default: 30 000. */
  timeoutMs?: number;
  /** Reintentos ante errores transitorios. Default: 2. */
  retries?: number;
  /** Callback de logging de bajo nivel. */
  onDebug?: (message: string) => void;
}

export class REST {
  readonly baseUrl: string;
  readonly environment: Environment;

  #apiKey?: string;
  #fetch: typeof fetch;
  #timeoutMs: number;
  #retries: number;
  #onDebug?: (message: string) => void;

  constructor(options: RESTOptions = {}) {
    this.environment = options.environment ?? "sandbox";
    this.baseUrl = (options.baseUrl ?? BASE_URLS[this.environment]).replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#retries = options.retries ?? 2;
    this.#onDebug = options.onDebug;

    if (typeof this.#fetch !== "function") {
      throw new EtherfuseNetworkError(
        "No hay implementación global de fetch. Usa Node >= 18 o pasa `fetch` en las opciones.",
      );
    }
  }

  setApiKey(apiKey: string): this {
    this.#apiKey = apiKey;
    return this;
  }

  get hasApiKey(): boolean {
    return Boolean(this.#apiKey);
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.#buildUrl(path, options.query);
    const retries = options.retries ?? this.#retries;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        this.#onDebug?.(`[REST] retry ${attempt}/${retries} en ${delay}ms → ${method} ${path}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        return await this.#execute<T>(method, url, path, options);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof EtherfuseNetworkError ||
          (error instanceof EtherfuseAPIError && error.isRetryable);
        if (!retryable || attempt === retries) throw error;
      }
    }

    // Inalcanzable, pero TypeScript no lo sabe.
    throw lastError;
  }

  async #execute<T>(
    method: string,
    url: string,
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.auth !== false && this.#apiKey) {
      // Etherfuse espera la key tal cual, sin "Bearer".
      headers["Authorization"] = this.#apiKey;
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    this.#onDebug?.(`[REST] ${method} ${path}`);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new EtherfuseNetworkError(`Fallo de red en ${method} ${path}`, { cause });
    } finally {
      clearTimeout(timer);
    }

    const payload = await REST.#parseBody(response);

    if (!response.ok) {
      throw new EtherfuseAPIError(response.status, method, path, payload);
    }
    return payload as T;
  }

  static async #parseBody(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => "");
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  #buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}
