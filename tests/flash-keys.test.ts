// Curated flash keys: every `?flash=<key>` a server action emits must have a message.
//
// A server action that finishes reports success by redirecting to `<page>?flash=<key>`, and
// src/components/ui/primitives/toast.tsx turns a KNOWN key into a toast — an unknown key shows
// nothing at all, by design (no free text from the URL). That design has a silent failure mode,
// and the forced password change shipped straight into it: `password_updated` and
// `password_force_change` were emitted but missing from the map, so both actions looked like they
// had done nothing. This test reads the emitters and the map from source and fails on the gap.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf-8");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [rel] : [];
  });
}

/** The keys of FLASH_MESSAGES, read from the object literal itself. */
function curatedKeys(): Set<string> {
  const src = read("src/components/ui/primitives/toast.tsx");
  const start = src.indexOf("const FLASH_MESSAGES");
  const end = src.indexOf("\n};", start);
  expect(start, "FLASH_MESSAGES bulunamadı").toBeGreaterThan(-1);
  const body = src.slice(start, end);
  return new Set([...body.matchAll(/^\s*([a-z_]+):\s*\{/gm)].map((m) => m[1]));
}

/** Every flash key an action can emit: literal `flash=<key>` anywhere in src, plus the
 * `done("<key>")` helper /system/security uses to build the same redirect. */
function emittedKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const rel of sourceFiles("src")) {
    if (rel.endsWith(path.join("primitives", "toast.tsx"))) continue;
    const src = read(rel);
    for (const m of src.matchAll(/flash=([a-z_]+)/g)) keys.set(m[1], rel);
    if (/function done\(flash: string\)/.test(src)) {
      for (const m of src.matchAll(/\bdone\("([a-z_]+)"\)/g)) keys.set(m[1], rel);
    }
  }
  return keys;
}

describe("flash anahtarları — gönderilen her anahtarın bir mesajı var", () => {
  it("zorunlu parola değişikliğinin iki anahtarı haritada", () => {
    const curated = curatedKeys();
    expect(curated.has("password_updated")).toBe(true);
    expect(curated.has("password_force_change")).toBe(true);
  });

  it("bir server action'ın gönderdiği hiçbir anahtar haritada eksik değil", () => {
    const curated = curatedKeys();
    const emitted = emittedKeys();
    // Not vacuous: the security screen alone emits seven keys and the archive flow one more.
    expect(emitted.size).toBeGreaterThanOrEqual(8);
    const missing = [...emitted].filter(([key]) => !curated.has(key)).map(([key, rel]) => `${key} (${rel})`);
    expect(missing).toEqual([]);
  });
});
