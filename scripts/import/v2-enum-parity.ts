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
import { targetFor } from "../../src/lib/importers/v2/domain-map";
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

/**
 * Bir CHECK'in SÖZLÜK kısıtı olup olmadığına bakar; öyleyse izinli değerleri döndürür.
 *
 * YALNIZ sade biçim kabul edilir: `CHECK ((col = ANY (ARRAY[...])))`. Bir kolonun birden
 * fazla CHECK'i olabiliyor ve bileşik olanlar sözlük DEĞİL. Örnek: loan_installments'ta
 * `status = ANY(ARRAY['paid','partial']) OR paid_at IS NULL` diye bir kısıt var — bu,
 * "ödeme tarihi yalnız ödenmiş/kısmi satırda olur" demek, "durum yalnız bu ikisi olabilir"
 * demek değil. Bileşik kısıtı sözlük sanmak, aracın kendi ürettiği sahte uyuşmazlıktır;
 * ilk sürümde tam olarak bu oldu.
 */
function allowedFromCheck(def: string): string[] | null {
  const m = /^CHECK \(\(([a-z_]+) = ANY \(ARRAY\[([^\]]*)\]\)\)\)$/.exec(def.trim());
  if (!m) return null;
  return [...m[2].matchAll(/'([^']*)'::text/g)].map((x) => x[1]);
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
      const col = /^CHECK \(\(([a-z_]+) = ANY/.exec(def.trim())?.[1];
      if (!col) continue;
      allowedByColumn.set(`${tbl.replace(/^public\./, "")}.${col}`, values);
    }

    const mismatches: Mismatch[] = [];
    let checked = 0;
    const unverified: string[] = [];
    const skipped: string[] = [];

    for (const sheet of DATA_SHEETS) {
      for (const col of sheet.columns) {
        if (col.type !== "enum" || !col.enumValues) continue;

        // Hedef kolon `domain-map.ts`'ten okunur. Domain'e yazılmayan kolonlar (defter,
        // karşılıksız) doğrulanacak bir CHECK'e sahip değildir; onları "doğrulanmadı"
        // diye saymak yanıltıcı olurdu — kararları zaten yazılı.
        const target = targetFor(sheet.name, col.key);
        if (!target || (target.kind !== "domain" && target.kind !== "parent")) {
          skipped.push(`${sheet.name}.${col.key} (${target?.kind ?? "kararsız"})`);
          continue;
        }

        const allowed = allowedByColumn.get(target.field);
        if (!allowed) {
          unverified.push(`${sheet.name}.${col.key} → ${target.field} (CHECK yok)`);
          continue;
        }

        checked++;
        const extra = col.enumValues.filter((v) => !allowed.includes(v));
        if (extra.length > 0) {
          const [table, column] = target.field.split(".");
          mismatches.push({
            table, column, sheet: sheet.name, key: col.key,
            offered: [...col.enumValues], allowed, extra,
          });
        }
      }
    }

    console.log(`\nDoğrulanan enum kolonu: ${checked}`);
    console.log(`Domain'e yazılmayan (defter/karşılıksız — CHECK'i yok): ${skipped.length}`);
    console.log(`Domain'e yazılan ama CHECK'i olmayan kolon: ${unverified.length}`);
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
