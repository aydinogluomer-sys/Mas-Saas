// Standart Import V2 — sözleşme enum'ları ile veritabanı CHECK'lerinin paritesi.
//
// NEDEN VAR. Şablondaki açılır listeler `contract.ts`'ten üretiliyor; kaydı kabul edecek olan
// ise veritabanının CHECK kısıtı. İkisi ayrı düşerse hata KULLANICIYA GEÇ ve YANLIŞ YERDE
// görünür: kişi şablonun kendi sunduğu bir değeri seçer, dosya doğrulamadan geçer, satır
// "hazır" görünür ve INSERT anında reddedilir. Kullanıcı açısından bu, doğru doldurduğu bir
// formun sebepsiz reddedilmesidir.
//
// İlk koşuda bulunan gerçek örnek: sözleşme kredi durumu olarak `restructured` sunuyordu,
// `public.loans.status` CHECK'i ise yalnız active/closed/planned/unknown kabul ediyor.
//
// KULLANIM. Harcanabilir bir veritabanına karşı çalışır; gerçek veritabanına yazmaz, yalnız
// katalog okur. Bulduğu her uyuşmazlığı yazar ve çıkış kodu 1 ile biter.
import { Pool } from "pg";
import { DATA_SHEETS } from "../../src/lib/importers/v2/contract";
import { requireOwnerDatabaseUrl } from "../db/owner-url";

interface Mismatch {
  table: string;
  column: string;
  sheet: string;
  key: string;
  offered: string[];
  allowed: string[];
  extra: string[];
}

/** Bir CHECK ifadesinden `x = ANY (ARRAY['a','b'])` biçimindeki izinli değerleri okur. */
function allowedFromCheck(def: string): string[] | null {
  if (!/= ANY \(ARRAY\[/.test(def)) return null;
  return [...def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireOwnerDatabaseUrl() });
  const client = await pool.connect();

  try {
    const dbName = (await client.query<{ d: string }>("select current_database() as d")).rows[0].d;
    console.log(`Veritabanı: ${dbName} (yalnız katalog okunuyor, yazma yok)`);

    // Tablo+kolon -> izinli değerler. Kolonu CHECK ifadesinin kendisinden okuyoruz.
    const checks = await client.query<{ tbl: string; def: string }>(
      `select conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def
         from pg_constraint
        where contype = 'c' and connamespace = 'public'::regnamespace`,
    );

    const allowedByColumn = new Map<string, string[]>();
    for (const { tbl, def } of checks.rows) {
      const values = allowedFromCheck(def);
      if (!values) continue;
      const col = /\(\(?([a-z_]+) = ANY/.exec(def)?.[1];
      if (!col) continue;
      allowedByColumn.set(`${tbl.replace(/^public\./, "")}.${col}`, values);
    }

    const mismatches: Mismatch[] = [];
    let checked = 0;
    const unverified: string[] = [];

    for (const sheet of DATA_SHEETS) {
      for (const col of sheet.columns) {
        if (col.type !== "enum" || !col.enumValues) continue;

        // Hedef kolonu yalnız sözleşme SÖYLEDİĞİNDE biliyoruz. `domainField` yoksa tahmin
        // etmiyoruz — yanlış kolonu doğrulamak, hiç doğrulamamaktan daha kötüdür.
        if (!col.domainField) {
          unverified.push(`${sheet.name}.${col.key}`);
          continue;
        }

        const allowed = allowedByColumn.get(col.domainField);
        if (!allowed) {
          unverified.push(`${sheet.name}.${col.key} → ${col.domainField} (CHECK yok)`);
          continue;
        }

        checked++;
        const extra = col.enumValues.filter((v) => !allowed.includes(v));
        if (extra.length > 0) {
          const [table, column] = col.domainField.split(".");
          mismatches.push({
            table, column, sheet: sheet.name, key: col.key,
            offered: [...col.enumValues], allowed, extra,
          });
        }
      }
    }

    console.log(`\nDoğrulanan enum kolonu: ${checked}`);
    console.log(`Doğrulanamayan (domainField tanımsız veya CHECK yok): ${unverified.length}`);
    for (const u of unverified) console.log(`   · ${u}`);

    if (mismatches.length === 0) {
      console.log("\nSONUÇ: uyuşmazlık yok — şablonun sunduğu her değer veritabanınca kabul edilir.");
      return;
    }

    console.log(`\nUYUŞMAZLIK: ${mismatches.length}`);
    for (const m of mismatches) {
      console.log(
        `\n  ${m.sheet}.${m.key} → ${m.table}.${m.column}\n` +
        `     şablon sunuyor : ${m.offered.join(", ")}\n` +
        `     veritabanı kabul: ${m.allowed.join(", ")}\n` +
        `     REDDEDİLECEK    : ${m.extra.join(", ")}`,
      );
    }
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
