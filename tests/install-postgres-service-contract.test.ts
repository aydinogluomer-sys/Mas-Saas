/**
 * `scripts/ops/install-postgres-service.ps1` — kaynak sözleşmesi.
 *
 * Script yönetici olarak, bir kez, gerçek kümenin üzerinde koşar; CI'da ya da bir testte
 * çalıştırılamaz. Bu yüzden repo'nun kaynak-sözleşmesi deseniyle (bkz. writer-surface.test.ts)
 * yapması GEREKENLERİ ve ASLA yapmaması gerekenleri metin üzerinden sabitler. Davranışsal kanıt
 * sahibin -WhatIf / gerçek koşu / ikinci koşu ("ZATEN KURULU") sırasıdır.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ops", "install-postgres-service.ps1");
const raw = readFileSync(SCRIPT);
/** Satır sonları normalleştirilir: checkout'ta CRLF'e çevrilmiş bir kopya da aynı sözleşmeyi taşır. */
const text = raw.toString("utf8").replace(/\r\n/g, "\n");

describe("install-postgres-service.ps1 — yapması gerekenler", () => {
  it.each([
    "#Requires -RunAsAdministrator",
    "#Requires -Version 5.1",
    "SupportsShouldProcess",
    "'register', '-N', $ServiceName, '-U', $NetworkServiceAccount, '-S', 'auto', '-D', $DataDir",
    "-S auto",
    "NT AUTHORITY\\NetworkService",
    "MAS-PostgreSQL16",
    "C:\\MAS\\pgdata16",
    "/inheritance:r",
    "*S-1-5-18",
    "*S-1-5-32-544",
    "*S-1-5-20",
    "'stop', '-D', $DataDir, '-m', 'fast'",
    "pg_isready",
    "'-h', '127.0.0.1'",
    "Unregister-ScheduledTask",
    "MAS-PostgreSQL16-Oturum-Baslat",
    "scram-sha-256",
    "AreAccessRulesProtected",
  ])("içerir: %s", (needle) => {
    expect(text).toContain(needle);
  });

  it("pg_hba yöntem izin listesi yalnız scram-sha-256 ve reject — 'trust' reddedilir", () => {
    expect(text).toContain("$method -notin @('scram-sha-256', 'reject')");
  });

  it("oturum görevi YALNIZ doğrulamadan sonra kaldırılır; başarısızlıkta geri etkinleştirilir", () => {
    const confirm = text.indexOf("$listeners = Confirm-Service\n\n# --- ADIM 7");
    const unregister = text.lastIndexOf("Unregister-ScheduledTask -TaskName $LogonTaskName");
    expect(confirm).toBeGreaterThan(0);
    expect(unregister).toBeGreaterThan(confirm);
    expect(text).toContain("Enable-ScheduledTask -TaskName $LogonTaskName");
  });
});

describe("install-postgres-service.ps1 — ASLA yapmaması gerekenler", () => {
  it.each(["initdb", " -P ", "PGPASSWORD", "ALTER ROLE", "0.0.0.0", "Remove-Item", "Stop-Process", "New-NetFirewallRule"])(
    "içermez: %s",
    (needle) => {
      expect(text).not.toContain(needle);
    },
  );

  it("saf ASCII — PowerShell 5.1 BOM'suz dosyayı ANSI kod sayfasıyla okur, Türkçe harfler bozulurdu", () => {
    expect([...raw].every((b) => b < 0x80)).toBe(true);
  });
});
