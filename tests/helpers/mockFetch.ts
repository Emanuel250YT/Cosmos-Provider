/** Helper de tests: fetch falso que graba peticiones y devuelve respuestas enlatadas. */

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockRule {
  /** Match por método+path, p. ej. "POST /ramp/quote". Soporta prefijo con "*" final. */
  route: string;
  status?: number;
  response?: unknown;
  /** Si se define, se usan en orden para llamadas sucesivas a la misma ruta. */
  sequence?: Array<{ status?: number; response?: unknown }>;
}

/** Body recorder: JSON string bodies parse to objects; `FormData` bodies become plain objects. */
function parseBody(body: BodyInit | null | undefined): unknown {
  if (!body) return undefined;
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const record: Record<string, FormDataEntryValue> = {};
    body.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  return JSON.parse(String(body));
}

export function createMockFetch(rules: MockRule[]) {
  const requests: RecordedRequest[] = [];
  const counters = new Map<string, number>();

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    requests.push({
      method,
      url,
      path: pathname,
      headers,
      body: parseBody(init?.body),
    });

    const key = `${method} ${pathname}`;
    const rule = rules.find((r) =>
      r.route.endsWith("*") ? key.startsWith(r.route.slice(0, -1)) : r.route === key,
    );
    if (!rule) {
      return new Response(JSON.stringify({ message: `sin mock para ${key}` }), { status: 404 });
    }

    let status = rule.status ?? 200;
    let payload = rule.response ?? {};
    if (rule.sequence) {
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      const step = rule.sequence[Math.min(n, rule.sequence.length - 1)]!;
      status = step.status ?? 200;
      payload = step.response ?? {};
    }

    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return { fetchImpl, requests };
}
