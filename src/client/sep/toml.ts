/**
 * Minimal TOML parser, scoped to what `stellar.toml` files actually use:
 * top-level `key = value` scalars, inline string arrays, `[TABLE]` headers,
 * and `[[TABLE]]` array-of-tables (`CURRENCIES`, `VALIDATORS`...).
 *
 * Not a general-purpose TOML parser (no multi-line strings, no dotted keys,
 * no inline tables) — deliberately, to keep this dependency-free. Anything
 * `stellar.toml` in the wild uses is covered.
 */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  // Stack of the object currently being written to (root, a `[TABLE]`, or the
  // last element pushed onto a `[[TABLE]]` array).
  let current: Record<string, unknown> = root;

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const arrayTableMatch = /^\[\[(.+)\]\]$/.exec(line);
    const tableMatch = /^\[(.+)\]$/.exec(line);

    if (arrayTableMatch) {
      const path = arrayTableMatch[1]!.trim();
      const arr = (root[path] as unknown[] | undefined) ?? [];
      const entry: Record<string, unknown> = {};
      arr.push(entry);
      root[path] = arr;
      current = entry;
      continue;
    }

    if (tableMatch) {
      const path = tableMatch[1]!.trim();
      const table: Record<string, unknown> = (root[path] as Record<string, unknown> | undefined) ?? {};
      root[path] = table;
      current = table;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    current[key] = parseValue(rawValue);
  }

  return root;
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    else if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseValue(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((v) => parseValue(v.trim()))
      .filter((v) => v !== "");
  }
  const num = Number(raw);
  if (raw !== "" && !Number.isNaN(num)) return num;
  return raw;
}
