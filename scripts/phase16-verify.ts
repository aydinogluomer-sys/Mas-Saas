// Faz 16 verification. Unlike the other phase scripts this one does not talk to the database
// directly — it boots the real production server and makes real HTTP requests, because every
// property it checks (middleware allowlist, status codes, rate limiting, CSRF) only exists at
// the HTTP layer and cannot be observed from a pg client.
//
// Read-only with respect to data: the only endpoints touched are /health (select 1), /ready,
// /version and unauthenticated /api/facts, which is refused before it reaches the database.
//
// Usage:
//   pnpm build && DATABASE_URL=... pnpm phase16:verify
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.PHASE16_PORT ?? 3117);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 90_000;

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function waitForServer(): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/ready`, { cache: "no-store" });
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** `redirect: "manual"` everywhere: the whole point of several checks is to observe the 307
 * to /login rather than silently follow it and score the login page as a success. */
function get(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${pathname}`, { redirect: "manual", cache: "no-store", ...init });
}

async function main(): Promise<void> {
  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    console.error("Üretim derlemesi yok — önce `pnpm build` çalıştırın.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL tanımlı değil — /health bu olmadan anlamlı sonuç vermez.");
    process.exit(1);
  }

  let server: ChildProcess | null = null;
  try {
    server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let serverLog = "";
    server.stdout?.on("data", (d: Buffer) => (serverLog += d.toString()));
    server.stderr?.on("data", (d: Buffer) => (serverLog += d.toString()));

    if (!(await waitForServer())) {
      console.error(`Sunucu ${BOOT_TIMEOUT_MS} ms içinde ayağa kalkmadı. Çıktı:\n${serverLog.slice(-3000)}`);
      process.exit(1);
    }

    // ── Teslimat A: /ready ve /health FARKLI sinyaller ────────────────────────────────────
    {
      const res = await get("/ready");
      const body = await res.json().catch(() => ({}));
      record("/ready 200 döner", res.status === 200, `status=${res.status}`);
      record(
        "/ready login'e YÖNLENDİRİLMEZ (middleware allowlist'inde)",
        res.status === 200 && !res.headers.get("location"),
        `location=${res.headers.get("location") ?? "yok"}`,
      );
      record(
        "/ready veritabanına DOKUNMAZ (yanıtta db alanı yok)",
        body.status === "ready" && !("db" in body),
        `gövde anahtarları: ${Object.keys(body).join(",")}`,
      );
    }

    {
      const res = await get("/health");
      const body = await res.json().catch(() => ({}));
      record(
        "/health veritabanını KONTROL EDER (yanıtta db alanı var)",
        "db" in body,
        `status=${res.status} db=${body.db ?? "—"}`,
      );
      record(
        "/health DB ayaktayken 200 döner",
        res.status === 200 && body.db === "up",
        `status=${res.status} db=${body.db}`,
      );
    }

    {
      const res = await get("/version");
      const body = await res.json().catch(() => ({}));
      record(
        "/version sürüm bilgisini döner, sır içermez",
        res.status === 200 && typeof body.version === "string" && !JSON.stringify(body).includes("postgres://"),
        `status=${res.status} version=${body.version ?? "—"}`,
      );
    }

    // Korumalı bir rota hâlâ kapalı mı? Allowlist'e `ready` eklemek onu genişletmemeli.
    {
      const res = await get("/overview");
      record(
        "korumalı rota hâlâ login'e yönlendirilir (allowlist genişlemedi)",
        res.status === 307 || res.status === 302,
        `status=${res.status} location=${res.headers.get("location") ?? "yok"}`,
      );
    }

    // ── Teslimat E: rate limiting ─────────────────────────────────────────────────────────
    {
      // Limit middleware'de, cookie kontrolünden ÖNCE uygulanır. Bu yüzden kimliksiz bir
      // istek dizisi önce login'e yönlendirilir (307), limit aşılınca 429'a döner — yani
      // 429'u gözlemek için oturum açmak gerekmez.
      const limit = 60; // RATE_RULES.api
      let sawRedirect = false;
      let rateLimited: Response | null = null;
      for (let i = 0; i < limit + 5; i++) {
        const res = await get("/api/facts");
        if (res.status === 307 || res.status === 302) sawRedirect = true;
        if (res.status === 429) {
          rateLimited = res;
          break;
        }
        await res.arrayBuffer().catch(() => undefined);
      }
      record(
        "limit altında kimliksiz /api/facts login'e yönlendirilir",
        sawRedirect,
        sawRedirect ? "307 gözlendi" : "307 hiç gözlenmedi",
      );
      record("limit aşılınca /api/facts 429 döner", rateLimited !== null, rateLimited ? "429 alındı" : "429 HİÇ alınmadı");
      if (rateLimited) {
        const body = await rateLimited.json().catch(() => ({}));
        record(
          "429 gövdesi api-response zarfını kullanır",
          typeof body?.error?.message === "string" && body?.error?.code === "rate_limited",
          `code=${body?.error?.code ?? "—"}`,
        );
        record(
          "429 retry-after başlığı taşır",
          Number(rateLimited.headers.get("retry-after")) > 0,
          `retry-after=${rateLimited.headers.get("retry-after") ?? "yok"}`,
        );
        record(
          "429 korelasyon kimliği taşır",
          Boolean(rateLimited.headers.get("x-request-id")),
          `x-request-id=${rateLimited.headers.get("x-request-id") ? "var" : "yok"}`,
        );
      }
    }

    // ── Teslimat C: korelasyon kimliği ────────────────────────────────────────────────────
    {
      const res = await get("/ready", { headers: { "x-request-id": "faz16-probe-0001" } });
      record(
        "gelen korelasyon kimliği yanıtta korunur",
        res.headers.get("x-request-id") === "faz16-probe-0001",
        `x-request-id=${res.headers.get("x-request-id") ?? "yok"}`,
      );
      const res2 = await get("/ready");
      record(
        "kimlik verilmediğinde üretilir",
        Boolean(res2.headers.get("x-request-id")),
        `x-request-id=${res2.headers.get("x-request-id") ? "üretildi" : "yok"}`,
      );
    }

    // ── Teslimat F: CSRF ──────────────────────────────────────────────────────────────────
    {
      // Next.js 15 server action POST'larında Origin/Host eşleşmesini kendisi zorunlu kılar.
      // Bunu VARSAYMIYORUZ, ölçüyoruz — ama uydurma bir action id ile ölçülemez: Next önce
      // action'ı çözer, bulamazsa her iki Origin için de 404 döner ve test hiçbir şey
      // kanıtlamaz (ilk yazımında tam olarak bu oldu). Bu yüzden gerçek action id derleme
      // çıktısındaki manifest'ten okunuyor.
      const manifestPath = path.join(ROOT, ".next", "server", "server-reference-manifest.json");
      let loginActionId: string | null = null;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        const entries: Record<string, unknown> = {
          ...((manifest.node as Record<string, unknown>) ?? {}),
          ...((manifest.edge as Record<string, unknown>) ?? {}),
        };
        loginActionId =
          Object.entries(entries).find(([, v]) => JSON.stringify(v).includes("app/login/page"))?.[0] ?? null;
      } catch (e) {
        loginActionId = null;
        console.error(`  (manifest okunamadı: ${messageOf(e)})`);
      }

      if (!loginActionId) {
        record("CSRF: /login için gerçek server-action id'si bulundu", false, `bulunamadı — ${manifestPath}`);
      } else {
        record("CSRF: /login için gerçek server-action id'si bulundu", true, loginActionId.slice(0, 12) + "…");

        // Durum kodu burada ayırt edici DEĞİL: Next bu sürümde reddi 500 olarak yüzeye
        // çıkarıyor ve server-action protokolünün tamamı curl'le üretilmediğinde aynı-origin
        // istek de 500 dönebiliyor. Kanıt olarak framework'ün KENDİ kararı okunuyor: reddettiği
        // istekte "Aborting the action" satırını yazıyor, kabul ettiğinde yazmıyor. Bu, durum
        // kodundan daha doğrudan bir kanıt — korumanın çalıştığını değil, çalıştığını GÖRÜYORUZ.
        const ABORT_MARKERS = ["Invalid Server Actions request", "does not match", "Aborting the action"];
        const post = (origin: string) =>
          fetch(`${BASE}/login`, {
            method: "POST",
            redirect: "manual",
            headers: { origin, "next-action": loginActionId! },
            // multipart: Next bir server action'ı ancak form gövdesiyle tanıyor;
            // urlencoded gönderildiğinde action hiç çözülmüyor ve 404 dönüyor.
            body: (() => {
              const fd = new FormData();
              fd.set("username", "faz16");
              fd.set("password", "faz16-yanlis-parola");
              return fd;
            })(),
          });

        const logSince = async (fn: () => Promise<Response>): Promise<{ status: number; added: string }> => {
          const before = serverLog.length;
          const res = await fn();
          await res.arrayBuffer().catch(() => undefined);
          // Sunucu logu ayrı bir akıştan geliyor; yazılması için kısa bir pay bırak.
          await new Promise((r) => setTimeout(r, 750));
          return { status: res.status, added: serverLog.slice(before) };
        };

        const foreign = await logSince(() => post("https://saldirgan.example"));
        const foreignAborted = ABORT_MARKERS.some((m) => foreign.added.includes(m));
        record(
          "yabancı Origin'li server-action isteği Next tarafından İPTAL EDİLİR",
          foreignAborted,
          foreignAborted
            ? `sunucu logu reddi bildirdi (status=${foreign.status})`
            : `log'da red izi YOK (status=${foreign.status})`,
        );

        const same = await logSince(() => post(BASE));
        const sameAborted = ABORT_MARKERS.some((m) => same.added.includes(m));
        record(
          "aynı Origin'li istek İPTAL EDİLMEZ (reddin nedeni gerçekten Origin)",
          !sameAborted,
          sameAborted ? "aynı Origin de reddedildi — test ayırt edici değil" : `red izi yok (status=${same.status})`,
        );
      }
    }
  } finally {
    if (server && server.pid !== undefined) {
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(-server.pid, "SIGTERM");
        }
      } catch {
        server.kill("SIGKILL");
      }
    }
  }

  // ── Teslimat B: DomainError → status eşlemesi, gerçek birim testiyle ────────────────────
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "src/lib/api-response.test.ts"], {
      cwd: ROOT,
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    record("api-response birim testleri geçiyor (DomainError→400, diğerleri→500)", true, "vitest exit 0");
  } catch (e) {
    record("api-response birim testleri geçiyor (DomainError→400, diğerleri→500)", false, messageOf(e).slice(0, 300));
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE16 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    process.exit(1);
  }
  console.log("PHASE16 VERIFY: ALL PASS");
}

main().catch((e) => {
  console.error("PHASE16 VERIFY FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
