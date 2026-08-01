/** Atom: jerarquía de errores de la librería. */

/** Error base: todo lo que lanza cosmos-providers hereda de aquí. */
export class EtherfuseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** La API respondió con un status HTTP de error. */
export class EtherfuseAPIError extends EtherfuseError {
  /** Status HTTP (400, 404, 409, 424...). */
  readonly status: number;
  /** Método HTTP de la petición que falló. */
  readonly method: string;
  /** Path de la petición que falló. */
  readonly path: string;
  /** Cuerpo crudo de la respuesta de error (JSON parseado o texto). */
  readonly body: unknown;

  constructor(status: number, method: string, path: string, body: unknown) {
    super(
      `Etherfuse API error ${status} on ${method} ${path}${EtherfuseAPIError.#describe(body)}`,
    );
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }

  static #describe(body: unknown): string {
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const msg = b["message"] ?? b["error"] ?? b["detail"];
      if (typeof msg === "string") return `: ${msg}`;
    }
    if (typeof body === "string" && body.length > 0) return `: ${body.slice(0, 200)}`;
    return "";
  }

  /** 424: cotización temporalmente no disponible — reintentable con backoff. */
  get isRetryable(): boolean {
    return this.status === 424 || this.status === 429 || this.status >= 500;
  }
}

/** Fallo de red o timeout antes de recibir respuesta. */
export class EtherfuseNetworkError extends EtherfuseError {}

/** El payload PIX (BR Code) es inválido o no se pudo construir/parsear. */
export class PixError extends EtherfuseError {}

/** Firma de webhook inválida. */
export class WebhookVerificationError extends EtherfuseError {}
