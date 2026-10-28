/**
 * `scripts/db/ensure.ts` — `pnpm dev` / `pnpm start` zincirinin veritabanı halkası.
 *
 * ═══ NEDEN BU TESTLER ═══
 *
 * 46541d8 bu kontrolü `localhost`/`127.0.0.1` alt dizesini içermeyen HER URL için sessizce
 * atlıyordu ("harici veritabanı aktif"). Bulut bağlantısı kesildi; uzak bir host artık ATLANMAZ,
 * REDDEDİLİR. Native yol ise salt-okur bir yoklamadır: hiçbir küme oluşturmaz, hiçbir hizmet
 * başlatmaz, kapalı bir kümede operatöre tek ve somut bir sonraki adım söyler. Karar saf bir
 * fonksiyonda (decideEnsure) yaşadığı için hepsi veritabanı olmadan sınanır; TCP yoklaması gerçek
 * bir yerel dinleyiciyle.
 */
import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import {
  decideEnsure, parseServiceStatus, pgDownMessage, probeTcp, waitForTcp, type ServiceState,
} from "../scripts/db/ensure";

const APP = "postgres://mas_radar_app:apppw-1234@127.0.0.1:5432/mas_radar_dev";
const OWNER = "postgres://postgres:ownerpw-5678@127.0.0.1:5432/mas_radar_dev";
const CLOUD = "postgresql://postgres.tenant:cloudpw-9999@aws-0-eu.pooler.example.com:6543/postgres";

describe("decideEnsure", () => {
  it("MAS_SKIP_DB_ENSURE=1 bilinçli atlamadır", () => {
    expect(decideEnsure({ MAS_SKIP_DB_ENSURE: "1", DATABASE_URL: CLOUD })).toEqual({ action: "skip" });
  });

  it("docker (yalnız CI) eski konteyner yolunu seçer", () => {
    expect(decideEnsure({ MAS_PG_RUNTIME: "docker", DATABASE_URL: APP })).toEqual({ action: "docker-legacy" });
  });

  it("geçersiz MAS_PG_RUNTIME exit 2 ile reddedilir", () => {
    expect(decideEnsure({ MAS_PG_RUNTIME: "podman", DATABASE_URL: APP })).toMatchObject({ action: "refuse", exitCode: 2 });
  });

  it("varsayılan native: loopback URL yoklanır", () => {
    expect(decideEnsure({ DATABASE_URL: APP, MIGRATION_DATABASE_URL: OWNER })).toEqual({
      action: "probe-native", host: "127.0.0.1", port: 5432, warnLocalhost: false,
    });
  });

  it("localhost 127.0.0.1 olarak yoklanır ve uyarı işaretlenir", () => {
    expect(decideEnsure({ DATABASE_URL: "postgres://u:pw12@localhost:5432/mas_radar_dev" })).toEqual({
      action: "probe-native", host: "127.0.0.1", port: 5432, warnLocalhost: true,
    });
  });

  it("[::1] ve özel port", () => {
    expect(decideEnsure({ MIGRATION_DATABASE_URL: "postgres://u:pw12@[::1]:5433/mas_radar_dev" })).toEqual({
      action: "probe-native", host: "::1", port: 5433, warnLocalhost: false,
    });
  });

  it("uzak (bulut) URL artık ATLANMAZ — reddedilir; host ve parola mesajda yok", () => {
    const d = decideEnsure({ DATABASE_URL: CLOUD });
    expect(d).toMatchObject({ action: "refuse", exitCode: 1 });
    const reason = (d as { reason: string }).reason;
    expect(reason).toMatch(/bu makine değil/);
    expect(reason).not.toContain("pooler.example.com");
    expect(reason).not.toContain("cloudpw-9999");
  });

  it("SUPABASE_DB_URL artık hiçbir şeyi baypas etmez", () => {
    expect(decideEnsure({ SUPABASE_DB_URL: CLOUD })).toMatchObject({ action: "refuse", exitCode: 1 });
    expect(decideEnsure({ SUPABASE_DB_URL: CLOUD, DATABASE_URL: APP })).toMatchObject({ action: "probe-native" });
  });

  it("hiç URL yoksa reddedilir", () => {
    expect(decideEnsure({})).toMatchObject({ action: "refuse", exitCode: 1 });
  });

  it("uygulama ve owner FARKLI sunuculara işaret ediyorsa (yarım güncellenmiş .env.local) reddedilir", () => {
    expect(decideEnsure({ DATABASE_URL: APP, MIGRATION_DATABASE_URL: OWNER.replace(":5432", ":5433") }))
      .toMatchObject({ action: "refuse", exitCode: 1 });
    expect(decideEnsure({ DATABASE_URL: APP, MIGRATION_DATABASE_URL: CLOUD }))
      .toMatchObject({ action: "refuse", exitCode: 1 });
  });

  it("aynı sunucu, farklı veritabanı meşrudur (doğrulama koşuları owner'ı harcanabilir DB'ye sabitler)", () => {
    expect(decideEnsure({ DATABASE_URL: APP, MIGRATION_DATABASE_URL: OWNER.replace("/mas_radar_dev", "/mas_radar_x_verify") }))
      .toMatchObject({ action: "probe-native", port: 5432 });
  });
});

describe("probeTcp / waitForTcp", () => {
  it("gerçek bir yerel dinleyici: açıkken true, kapandıktan sonra false", async () => {
    const server: Server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") reject(new Error("port alınamadı"));
        else resolve(address.port);
      });
    });
    expect(await probeTcp("127.0.0.1", port, 1000)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeTcp("127.0.0.1", port, 1000)).toBe(false);
  });

  it("ilk başarıda döner", async () => {
    const answers = [false, false, true, true];
    let calls = 0;
    const ok = await waitForTcp("127.0.0.1", 5432, 10, 1, async () => answers[calls++] ?? false);
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("hepsi başarısızsa deneme sayısı kadar sorar ve false döner", async () => {
    let calls = 0;
    const ok = await waitForTcp("127.0.0.1", 5432, 3, 1, async () => { calls += 1; return false; });
    expect(ok).toBe(false);
    expect(calls).toBe(3);
  });
});

describe("parseServiceStatus / pgDownMessage", () => {
  it("Get-Service çıktısı: enum adı yerelleştirilmez; boş = hizmet yok", () => {
    expect(parseServiceStatus("Running\r\n")).toBe("running");
    expect(parseServiceStatus("Stopped")).toBe("stopped");
    expect(parseServiceStatus("")).toBe("missing");
    expect(parseServiceStatus("StartPending")).toBe("unknown");
  });

  const NEXT_STEP: Record<ServiceState, RegExp> = {
    missing: /install-postgres-service\.ps1[\s\S]*Start-ScheduledTask -TaskName 'MAS-PostgreSQL16-Oturum-Baslat'/,
    stopped: /Start-Service MAS-PostgreSQL16/,
    running: /listen_addresses/,
    unknown: /Get-Service MAS-PostgreSQL16/,
  };

  it.each(Object.keys(NEXT_STEP) as ServiceState[])("'%s': hizmet adı + tek somut sonraki adım + hiçbir şey yaratılmadığı", (state) => {
    const msg = pgDownMessage({ host: "127.0.0.1", port: 5432, serviceName: "MAS-PostgreSQL16", state });
    expect(msg).toContain("MAS-PostgreSQL16");
    expect(msg).toContain("127.0.0.1:5432");
    expect(msg).toMatch(NEXT_STEP[state]);
    expect(msg).toContain("hiçbir küme OLUŞTURMAZ");
  });
});
