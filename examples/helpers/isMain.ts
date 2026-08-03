import { fileURLToPath } from "node:url";

/** `true` when the module at `moduleUrl` (pass `import.meta.url`) is the script Node was invoked with directly — false when it was merely imported by another module (e.g. `all-flows.ts`). */
export function isMainModule(moduleUrl: string): boolean {
  return !!process.argv[1] && process.argv[1] === fileURLToPath(moduleUrl);
}
