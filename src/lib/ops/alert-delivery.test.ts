// AŞAMA 09 — teslimat katmanının saf/dosya davranışı.
//
// Rehber §30.1: yalnız yeşile dönebilen bir kapı hiçbir şey kanıtlamaz. Bu yüzden her testin
// çifti var: maskeleme SIZDIRMAZ **ve** maskelenmemiş metni SIZINTI olarak İŞARETLER; teslimat
// başarılı olur **ve** kanal düştüğünde rapor bunu görünür kılar.
//
// DB yok, ağ yok: kanal ağ tarafı `mockTransport` ile sürülür — ortamda erişilebilir bir
// Telegram/e-posta ucu yok ve gerçek bir uca istek atmak bu testin işi değil.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockTransport } from "@/lib/reminders/transport";
import {
  buildLogEntries,
  deliverAlerts,
  formatAlertMessage,
  looksLikeSecret,
  parseAlertChannels,
  redactSecrets,
  type AlertLogEntry,
  type TelemetryAlert,
} from "./alert-delivery";

const ALERT: TelemetryAlert = {
  signal: "backup_age_hours",
  section: "DB",
  value: "YEDEK YOK",
  threshold: "eşik 36s",
  severity: "P1",
  message: "backup_age_hours = YEDEK YOK (eşik 36s)",
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "mas-alert-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function readLog(file: string): AlertLogEntry[] {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as AlertLogEntry);
}

describe("redactSecrets", () => {
  it("bağlantı dizesinin parolasını maskeler, ana bilgisayarı bırakır", () => {
    const out = redactSecrets("postgres://postgres:s3cret@127.0.0.1:5432/mas_radar_dev");
    expect(out).not.toContain("s3cret");
    expect(out).toContain("127.0.0.1:5432/mas_radar_dev");
  });

  it("telegram bot token'ını URL içinde maskeler", () => {
    const out = redactSecrets("https://api.telegram.org/bot123456789:AAF-abcDEF_ghi/sendMessage");
    expect(out).not.toContain("AAF-abcDEF_ghi");
    expect(out).toContain("/bot***");
  });

  it("Bearer başlığını maskeler", () => {
    expect(redactSecrets("authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("anahtar=değer biçimindeki sırları maskeler", () => {
    const out = redactSecrets("api_key=abcd1234 chat_id: 998877665 password=hunter2");
    expect(out).not.toContain("abcd1234");
    expect(out).not.toContain("998877665");
    expect(out).not.toContain("hunter2");
  });

  it("şekli tanınmayan ama DEĞERİ bilinen sırrı tam eşleşmeyle maskeler", () => {
    const out = redactSecrets("kanal hedefi -1001234567890 idi", ["-1001234567890"]);
    expect(out).not.toContain("-1001234567890");
    expect(out).toContain("***");
  });

  it("çok kısa değerleri BİLEREK maskelemez (okunmaz alarm da alarm değildir)", () => {
    expect(redactSecrets("jobs_stuck = 1", ["1"])).toBe("jobs_stuck = 1");
  });

  it("sırsız metni değiştirmez", () => {
    const clean = "backup_age_hours = YEDEK YOK (eşik 36s)";
    expect(redactSecrets(clean)).toBe(clean);
  });
});

describe("looksLikeSecret", () => {
  it("maskelenmemiş sırrı YAKALAR (kapı yalnız yeşile dönemez)", () => {
    expect(looksLikeSecret("postgres://postgres:s3cret@h/db").length).toBeGreaterThan(0);
    expect(looksLikeSecret("Bearer eyJhbGciOiJIUzI1NiJ9").length).toBeGreaterThan(0);
    expect(looksLikeSecret("token=abcd1234").length).toBeGreaterThan(0);
  });

  it("maskelenmiş hâli sır SAYMAZ", () => {
    expect(looksLikeSecret(redactSecrets("postgres://postgres:s3cret@h/db"))).toEqual([]);
    expect(looksLikeSecret(redactSecrets("token=abcd1234"))).toEqual([]);
  });

  it("yapılandırılmış sır değeri açıktaysa yakalar", () => {
    expect(looksLikeSecret("hedef -1001234567890", ["-1001234567890"]).length).toBe(1);
  });

  it("temiz telemetri satırını sır saymaz", () => {
    expect(looksLikeSecret("  ok   schema_ledger  87/0087  — beklenen 87/0087")).toEqual([]);
  });
});

describe("parseAlertChannels", () => {
  it("tanımsızken bile 'log' her zaman listede (fail-safe taban kapatılamaz)", () => {
    expect(parseAlertChannels(undefined)).toEqual({ channels: ["log"], unknown: [] });
  });
  it("bilinen kanalları ekler ve tekrarları yutar", () => {
    expect(parseAlertChannels("log, telegram ,TELEGRAM,email").channels).toEqual(["log", "telegram", "email"]);
  });
  it("bilinmeyen jetonu SESSİZCE ATMAZ", () => {
    const r = parseAlertChannels("telegran,log");
    expect(r.unknown).toEqual(["telegran"]);
    expect(r.channels).toEqual(["log"]);
  });
});

describe("formatAlertMessage", () => {
  it("uyarı yokken ALL CLEAR der", () => {
    expect(formatAlertMessage("r1", [])).toContain("ALL CLEAR");
  });
  it("en yüksek severity'yi başlığa taşır ve her sinyali listeler", () => {
    const msg = formatAlertMessage("r1", [ALERT, { ...ALERT, signal: "runtime_user", severity: "P0" }]);
    expect(msg).toContain("en yuksek P0");
    expect(msg).toContain("backup_age_hours");
    expect(msg).toContain("runtime_user");
  });
});

describe("buildLogEntries", () => {
  it("uyarı yokken heartbeat satırı üretir (sessiz log = toplayıcı çalışmadı ile karışır)", () => {
    const e = buildLogEntries("r1", [], new Date("2026-08-25T10:00:00Z"));
    expect(e).toHaveLength(1);
    expect(e[0].kind).toBe("heartbeat");
  });
  it("her uyarı için bir satır üretir ve alanları taşır", () => {
    const e = buildLogEntries("r1", [ALERT], new Date("2026-08-25T10:00:00Z"));
    expect(e[0]).toMatchObject({ kind: "alert", signal: "backup_age_hours", severity: "P1", section: "DB" });
  });
  it("satır alanlarına maskeleme uygular", () => {
    const e = buildLogEntries("r1", [{ ...ALERT, value: "postgres://u:pw1234@h/db" }], new Date(), []);
    expect(e[0].value).not.toContain("pw1234");
  });
});

describe("deliverAlerts", () => {
  it("sağlıklı koşu: heartbeat yazar, ALERT satırı YAZMAZ, ek kanalı denemez", async () => {
    const file = path.join(dir, "alerts.jsonl");
    const tg = mockTransport({ channel: "telegram" });
    const rep = await deliverAlerts({
      runId: "r-clean", alerts: [], logPath: file, channels: ["log", "telegram"], transports: { telegram: tg },
    });
    expect(rep.allDelivered).toBe(true);
    const rows = readLog(file);
    expect(rows.filter((r) => r.kind === "alert")).toHaveLength(0);
    expect(rows.filter((r) => r.kind === "heartbeat")).toHaveLength(1);
    expect(tg.sent).toHaveLength(0);
    expect(rep.outcomes.find((o) => o.channel === "telegram")?.attempted).toBe(false);
  });

  it("uyarılı koşu: log'a alert + delivery satırları yazar ve ek kanala GÖNDERİR", async () => {
    const file = path.join(dir, "alerts.jsonl");
    const tg = mockTransport({ channel: "telegram" });
    const rep = await deliverAlerts({
      runId: "r-alert", alerts: [ALERT], logPath: file, channels: ["log", "telegram"], transports: { telegram: tg },
    });
    expect(rep.allDelivered).toBe(true);
    const rows = readLog(file);
    expect(rows.filter((r) => r.kind === "alert")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "delivery" && r.ok === true)).toHaveLength(2);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toContain("backup_age_hours");
  });

  it("KANAL DÜŞERSE: allDelivered=false VE log'da ok:false teslimat satırı var", async () => {
    const file = path.join(dir, "alerts.jsonl");
    const tg = mockTransport({ channel: "telegram", failOn: () => true });
    const rep = await deliverAlerts({
      runId: "r-fail", alerts: [ALERT], logPath: file, channels: ["log", "telegram"], transports: { telegram: tg },
    });
    expect(rep.allDelivered).toBe(false);
    const failRow = readLog(file).find((r) => r.kind === "delivery" && r.channel === "telegram");
    expect(failRow?.ok).toBe(false);
    expect(failRow?.message).toContain("İLETİLEMEDİ");
  });

  it("fırlatan taşıyıcı da teslimat BAŞARISIZLIĞIDIR, çökme değil", async () => {
    const file = path.join(dir, "alerts.jsonl");
    const boom = {
      channel: "email" as const,
      async send(): Promise<never> { throw new Error("ağ yok"); },
    };
    const rep = await deliverAlerts({
      runId: "r-throw", alerts: [ALERT], logPath: file, channels: ["log", "email"], transports: { email: boom },
    });
    expect(rep.allDelivered).toBe(false);
    expect(rep.outcomes.find((o) => o.channel === "email")?.error).toContain("ağ yok");
  });

  it("YEREL LOG YAZILAMAZSA teslimat başarısız sayılır (birincil kanal sessizce düşemez)", async () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "bu bir dosya, dizin değil");
    const rep = await deliverAlerts({
      runId: "r-nolog", alerts: [ALERT], logPath: path.join(blocker, "alt", "alerts.jsonl"), channels: ["log"],
    });
    expect(rep.allDelivered).toBe(false);
    expect(rep.outcomes[0]).toMatchObject({ channel: "log", attempted: true, ok: false });
    expect(existsSync(path.join(blocker, "alt"))).toBe(false);
  });

  it("SIR SIZDIRMAZ: uyarı değerindeki bağlantı dizesi ne log'a ne mesaja geçer", async () => {
    const file = path.join(dir, "alerts.jsonl");
    const tg = mockTransport({ channel: "telegram" });
    await deliverAlerts({
      runId: "r-secret",
      alerts: [{ ...ALERT, signal: "runtime_user", value: "BAĞLANAMADI: postgres://postgres:sup3rs3cret@127.0.0.1/db" }],
      logPath: file, channels: ["log", "telegram"], transports: { telegram: tg },
      redactValues: ["sup3rs3cret"],
    });
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("sup3rs3cret");
    expect(looksLikeSecret(raw, ["sup3rs3cret"])).toEqual([]);
    expect(tg.sent.join("\n")).not.toContain("sup3rs3cret");
  });

  it("append'tir: ikinci koşu birincinin satırlarını EZMEZ", async () => {
    const file = path.join(dir, "alerts.jsonl");
    await deliverAlerts({ runId: "r1", alerts: [], logPath: file, channels: ["log"] });
    await deliverAlerts({ runId: "r2", alerts: [ALERT], logPath: file, channels: ["log"] });
    const ids = new Set(readLog(file).map((r) => r.runId));
    expect(ids).toEqual(new Set(["r1", "r2"]));
  });
});
