/**
 * Atom: HTTP transport layer.
 *
 * - Authentication: the API key goes in `Authorization` WITHOUT the `Bearer` prefix.
 * - Retries with exponential backoff for 424/429/5xx and network errors.
 * - Isomorphic: uses the global `fetch` (Node >= 18 and browsers).
 */

import { BASE_URLS, type Environment } from "@/atoms/constants";
import { EtherfuseAPIError, EtherfuseNetworkError } from "@/atoms/errors";

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  /** Query string (undefined/null values are omitted). */
  query?: Record<string, QueryValue>;
  /** JSON body. */
  body?: unknown;
  /** Additional headers. */
  headers?: Record<string, string>;
  /** If `false`, the API key is not sent (public /lookup endpoints). */
  auth?: boolean;
  /** Overrides the configured retry count for this request. */
  retries?: number;
}

export interface RESTOptions {
  /** Etherfuse API key (sandbox and production use different keys). */
  apiKey?: string;
  /** `sandbox` (default) or `production`. */
  environment?: Environment;
  /** Overrides the base URL derived from the environment. */
  baseUrl?: string;
  /** Fetch implementation to use (defaults to the global one). */
  fetch?: typeof fetch;
  /** Timeout per attempt, in ms. Default: 30,000. */
  timeoutMs?: number;
  /** Retries on transient errors. Default: 2. */
  retries?: number;
  /** Low-level logging callback. */
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
        "No global fetch implementation found. Use Node >= 18 or pass `fetch` in the options.",
      );
    }
  }

  /** Hot-swaps the API key (e.g. after rotating it) without recreating the client. */
  setApiKey(apiKey: string): this {
    this.#apiKey = apiKey;
    return this;
  }

  /** `true` if an API key is configured. */
  get hasApiKey(): boolean {
    return Boolean(this.#apiKey);
  }

  /** GET with retries and an optional query string. */
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  /** POST with a JSON body. */
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  /** PUT with a JSON body. */
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  /** PATCH with a JSON body. */
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  /** DELETE. Most Etherfuse endpoints return no body. */
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  /**
   * Generic request with retries: retries with exponential backoff +
   * jitter on network errors or retryable responses (424/429/5xx),
   * up to `options.retries` times (or the client default).
   */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.#buildUrl(path, options.query);
    const retries = options.retries ?? this.#retries;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        this.#onDebug?.(`[REST] retry ${attempt}/${retries} in ${delay}ms → ${method} ${path}`);
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

    // Unreachable, but TypeScript doesn't know that.
    throw lastError;
  }

  /** A single HTTP attempt (no retries): builds headers/body, applies the timeout, and maps the response or error. */
  async #execute<T>(
    method: string,
    url: string,
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.auth !== false && this.#apiKey) {
      // Etherfuse expects the key as-is, without "Bearer".
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
      throw new EtherfuseNetworkError(`Network failure on ${method} ${path}`, { cause });
    } finally {
      clearTimeout(timer);
    }

    const payload = await REST.#parseBody(response);

    if (!response.ok) {
      throw new EtherfuseAPIError(response.status, method, path, payload);
    }
    return payload as T;
  }

  /** Reads the body as JSON; if it doesn't parse (or is empty), returns the raw text or `null`. */
  static async #parseBody(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => "");
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Builds the final URL: `baseUrl + path` with the query string (omitting `undefined`/`null` values). */
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
