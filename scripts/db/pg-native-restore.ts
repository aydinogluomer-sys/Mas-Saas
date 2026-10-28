// Native yazıcı — YALNIZ HARCANABİLİR veritabanları için: düşür, yarat, arşivi yükle.
//
// Kullananlar: restore drill (scripts/release/restore-drill.ts) ve aylık AŞAMA 07 kapısı
// (scripts/release/stage07-backup-gate.ts). İkisi de bir yedeğin GERÇEKTEN geri yüklenebildiğini
// kanıtlamak için ayrı bir veritabanına restore eder; bu, yıllarca konteyner içinde
// `docker exec … dropdb/createdb/pg_restore` ile yapıldı.
//
// NEDEN SALT-OKUR MODÜLDEN AYRI. backup-native-postgres.ts gerçek kaynağa dokunur ve hiçbir şey
// yazmaz; bu dosya gerçek kaynağa HİÇ dokunmaz ve yalnız adıyla harcanabilir olduğunu söyleyen
// hedeflere yazar. İki yeteneği aynı dosyada tutmak, writer-surface denetiminin "bu dosya yazar
// mı" sorusunu bulanıklaştırırdı.
//
// KAPI HER FONKSİYONUN İLK İFADESİ. p24b-smoke-target.ts'in başlığında yazılı ders aynen burada
// da geçerli: yıkıcı bir araç hedefini adlandırmadan ÖNCE reddetmeli. İki bağımsız kural birlikte
// uygulanır — owner-url.ts'in harcanabilirlik işareti VE smokeTargetBlockers (düz tanımlayıcı,
// korunan ad değil, mas_radar_dev değil, kaynağın kendisi değil). İkisinden biri düşerse hiçbir
// süreç başlatılmaz.
//
// `--no-acl` YOK. restore-drill.ts'in ölçtüğü gibi: ACL'siz bir restore veritabanını mükemmel
// geri getirir ve uygulamayı DIŞARIDA bırakır ("permission denied for table users"). GRANT'lar
// geri gelmesi gerekenin parçasıdır.
import path from "node:path";
import { isDisposableDatabaseName } from "./owner-url";
import { smokeTargetBlockers } from "./p24b-smoke-target";
import { PgToolError, runPgToolSync, type ExecFileSyncLike } from "./backup-native-postgres";
import { buildLibpqEnv, type NativePgTarget, type PgBinaries } from "./pg-native";

export interface NativeRestoreContext {
  readonly target: NativePgTarget;
  readonly bins: PgBinaries;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Test seam: gerçek süreç yerine çağrıları kaydeden bir sahte. */
  readonly execImpl?: ExecFileSyncLike;
}

/** Harcanabilirlik kapısı — iki kural, ikisi de geçmeden hiçbir araç çalışmaz. */
function assertDisposableTarget(name: string, sourceDb: string): void {
  if (!isDisposableDatabaseName(name)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${name}' harcanabilir bir ad değil — bu araç hedefi DROP/CREATE eder ` +
        "ve yalnız harcanabilir işaret taşıyan adları kabul eder.",
    );
  }
  const decision = smokeTargetBlockers(name, sourceDb);
  if (!decision.ok) {
    throw new Error(`GÜVENLİK DURDURMASI: ${decision.blockers.join("; ")}`);
  }
}

function baseOf(ctx: NativeRestoreContext): Readonly<Record<string, string | undefined>> {
  return ctx.baseEnv ?? process.env;
}

/** Bakım bağlantısı (`postgres` veritabanı) — düşürme/yaratma oraya bağlanarak yapılır. */
function maintenanceEnv(ctx: NativeRestoreContext): Record<string, string> {
  return buildLibpqEnv(ctx.target, baseOf(ctx), { database: "postgres", appName: "mas-restore" });
}

export function dropDisposableNative(ctx: NativeRestoreContext, name: string, sourceDb: string): void {
  assertDisposableTarget(name, sourceDb);
  runPgToolSync(
    ctx.bins.dropdb,
    ["--force", "--if-exists", "--no-password", "--maintenance-db=postgres", name],
    { env: maintenanceEnv(ctx), tool: "dropdb", secrets: [ctx.target.password], execImpl: ctx.execImpl },
  );
}

export function createDisposableNative(ctx: NativeRestoreContext, name: string, sourceDb: string): void {
  assertDisposableTarget(name, sourceDb);
  runPgToolSync(
    ctx.bins.createdb,
    ["--no-password", "--maintenance-db=postgres", name],
    { env: maintenanceEnv(ctx), tool: "createdb", secrets: [ctx.target.password], execImpl: ctx.execImpl },
  );
}

/**
 * Arşivi harcanabilir hedefe yükler. pg_restore iyi huylu uyarılarda (olmayan rol, mevcut
 * extension) sıfırdan farklı döner; restore'un gerçekten olup olmadığına çağıranın parmak izi
 * karşılaştırması karar verir, çıkış kodu değil — bu yüzden sıfırdan farklı çıkış `warned` olur,
 * istisna değil. Aracın hiç başlayamaması (bulunamaması, zaman aşımı) ise istisnadır.
 */
export function restoreIntoNative(
  ctx: NativeRestoreContext,
  name: string,
  dumpPath: string,
  sourceDb: string,
): { warned: boolean; stderrTail: string } {
  assertDisposableTarget(name, sourceDb);
  try {
    runPgToolSync(
      ctx.bins.pgRestore,
      ["--no-owner", "--no-password", `--dbname=${name}`, path.resolve(dumpPath)],
      {
        env: buildLibpqEnv(ctx.target, baseOf(ctx), { database: name, appName: "mas-restore" }),
        tool: "pg_restore",
        timeoutMs: 60 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
        secrets: [ctx.target.password],
        execImpl: ctx.execImpl,
      },
    );
    return { warned: false, stderrTail: "" };
  } catch (err) {
    if (err instanceof PgToolError && err.status !== null) return { warned: true, stderrTail: err.stderrTail };
    throw err;
  }
}
