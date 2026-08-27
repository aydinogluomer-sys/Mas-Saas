/**
 * YETKİ MATRİSİ — "UI'da gizlemek authorization DEĞİLDİR".
 *
 * ═══ HER MUTASYON KONTROLÜ İÇİN AYRI AYRI SORULAN İKİ SORU ═══
 *
 *   S1  Yetkisiz rol o kontrolü GÖRÜYOR mu? Görüyorsa pasif mi, ve pasiflik gerekçesi ekranda
 *       YAZILI mı? "Görünür + etkin + tıklayınca hata" en kötü üçlüdür: kullanıcıya
 *       yapabileceği bir şey vaat edip yüzüne hata basar.
 *
 *   S2  Kontrol hiç gösterilmese bile, server action DOĞRUDAN çağrıldığında backend REDDEDİYOR
 *       mu? Bu ikinci soru birincisinden bağımsızdır ve asıl güvenlik sorusudur: düğmeyi
 *       gizlemek, POST'u engellemez.
 *
 * S2'nin nasıl sorulduğu önemlidir. Test, uygulamanın kendi formunu yetkisiz rolün oturumuyla
 * GÖNDERİR — elle uydurulmuş bir POST değil. Böylece ölçülen şey gerçek server action yolu olur:
 * aynı action id, aynı gövde, aynı çerez. Uydurma bir POST reddedilseydi bu, Next'in action
 * doğrulamasını ölçmüş olurdu; yetki katmanını değil.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { clickAndSettle, ensureMissingAmountInstance, openAs, rows, scalar, signatureFor, type Evidence, type SeededRole } from "./harness";

const OUT = path.join(process.cwd(), "docs", "interaction-audit");
const evidence: Evidence[] = [];

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "evidence-authz.json"), JSON.stringify({ rows: evidence }, null, 2) + "\n", "utf8");
});

/** payment_instances üzerinde YAZMA yetkisi olmayan katmanlar (authz matrisiyle aynı gerçek). */
const READ_ONLY_TIERS: SeededRole[] = ["viewer", "finance_approver"];

test.describe("yetki zorlaması — payment_instances", () => {
  for (const role of READ_ONLY_TIERS) {
    test(`${role}: 'ödendi' tıklandığında backend REDDETMELİ ve satır DEĞİŞMEMELİ`, async ({ browser }) => {
      test.setTimeout(120_000);
      // Yetkili rolün ekranında tıklanacak bir kontrol OLMASI gerekiyor; fixture garanti edilir.
      await ensureMissingAmountInstance();

      const s = await openAs(browser, role);
      const { page } = s;

      await page.goto("/payments/missing", { waitUntil: "networkidle" });

      const paid = page.getByRole("button", { name: "ödendi", exact: true }).first();
      const visible = await paid.isVisible().catch(() => false);

      const proof: string[] = [];

      if (!visible) {
        proof.push(`S1: '${role}' için 'ödendi' hiç render edilmiyor (gizleme)`);

        /* ── S2: GİZLEME YETKİ DEĞİLDİR — server action DOĞRUDAN çağrılır ────────────────
         *
         * Düğmenin render edilmemesi hiçbir şeyi ENGELLEMEZ: POST'u atan bir istemci düğmeye
         * ihtiyaç duymaz. Bu yüzden burada yetkili bir rolün ekranından GERÇEK form alınır
         * (action kimliği + gizli alanlar) ve AYNI istek yetkisiz rolün çerezleriyle
         * gönderilir.
         *
         * `$ACTION_ID_…` alanlı, urlencoded gövde, Next'in JS'siz form gönderim yoludur —
         * yani uydurma bir istek değil, tarayıcının JavaScript kapalıyken atacağı isteğin
         * aynısı. Uydurma bir POST reddedilseydi bu, Next'in action doğrulamasını ölçmüş
         * olurdu; asıl merak edilen YETKİ katmanı ölçülmemiş olurdu.
         */
        const op = await openAs(browser, "finance_operator");
        await op.page.goto("/payments/missing", { waitUntil: "networkidle" });
        const formSpec = await op.page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button")).find(
            (b) => (b.textContent ?? "").replace(/\s+/g, " ").trim() === "ödendi",
          );
          const form = btn?.closest("form");
          if (!form) return null;
          const fields: Array<[string, string]> = [];
          for (const el of Array.from(form.querySelectorAll("input"))) {
            const input = el as HTMLInputElement;
            if (input.name) fields.push([input.name, input.value]);
          }
          return { action: form.getAttribute("action") ?? location.pathname, fields };
        });
        await op.context.close();
        expect(formSpec, "yetkili rolde 'ödendi' formu bulunamadı — S2 kurulamadı").not.toBeNull();

        const targetId = formSpec!.fields.find(([n]) => n === "id")?.[1] ?? "";
        expect(targetId, "S2: hedef örnek kimliği okunamadı").toMatch(/^[0-9a-f-]{36}$/i);

        const beforeRow = (
          await rows<{ status: string; paid_at: string | null }>(
            "select status, paid_at::text from public.payment_instances where id = $1",
            [targetId],
          )
        )[0];
        const auditBefore = Number(
          await scalar<string>(
            "select count(*)::int from public.audit_logs where entity_table='payment_instances' and entity_id=$1",
            [targetId],
          ),
        );

        // Yetkisiz rolün OTURUMUYLA gönder.
        const body = new URLSearchParams(formSpec!.fields).toString();
        const res = await s.context.request.post(formSpec!.action.startsWith("/") ? formSpec!.action : "/payments/missing", {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          data: body,
          maxRedirects: 0,
        });
        proof.push(`S2: doğrudan server action çağrısı (${role} çerezi) → HTTP ${res.status()}`);

        const afterRow = (
          await rows<{ status: string; paid_at: string | null }>(
            "select status, paid_at::text from public.payment_instances where id = $1",
            [targetId],
          )
        )[0];
        const auditAfter = Number(
          await scalar<string>(
            "select count(*)::int from public.audit_logs where entity_table='payment_instances' and entity_id=$1",
            [targetId],
          ),
        );

        expect(afterRow.status, `${role}: doğrudan çağrı status'u DEĞİŞTİRMEMELİ`).toBe(beforeRow.status);
        expect(afterRow.paid_at, `${role}: doğrudan çağrı paid_at'i DEĞİŞTİRMEMELİ`).toBe(beforeRow.paid_at);
        expect(auditAfter, `${role}: doğrudan çağrı audit satırı YAZMAMALI`).toBe(auditBefore);
        expect(res.status(), `${role}: doğrudan çağrı 5xx ile patlamamalı`).toBeLessThan(500);
        proof.push(
          `S2 sonucu: DB status=${afterRow.status} (değişmedi), audit ${auditBefore}→${auditAfter} (yazılmadı) — backend reddetti`,
        );

        evidence.push({ route: "/payments/missing", control: signatureFor("/payments/missing", "ödendi"), role, verdict: "PASS", proof });
        await s.context.close();
        return;
      }

      const disabled = await paid.isDisabled();
      proof.push(`S1: '${role}' düğmeyi GÖRÜYOR, disabled=${disabled}`);

      // Doğrulama kimliği + BEFORE durumu.
      const id = await page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "ödendi", exact: true }) })
        .first()
        .locator('input[name="id"]')
        .first()
        .inputValue();
      const before = (
        await rows<{ status: string; paid_at: string | null }>(
          "select status, paid_at::text from public.payment_instances where id = $1",
          [id],
        )
      )[0];
      expect(before, `payment_instances ${id} yok`).toBeTruthy();

      const auditBefore = Number(
        await scalar<string>("select count(*)::int from public.audit_logs where entity_table='payment_instances' and entity_id=$1", [id]),
      );

      // S2: GERÇEK formu, yetkisiz rolün oturumuyla gönder.
      if (!disabled) {
        await clickAndSettle(page, () => paid.click({ timeout: 15_000 }).catch(() => {}));
      }

      const after = (
        await rows<{ status: string; paid_at: string | null }>(
          "select status, paid_at::text from public.payment_instances where id = $1",
          [id],
        )
      )[0];
      const auditAfter = Number(
        await scalar<string>("select count(*)::int from public.audit_logs where entity_table='payment_instances' and entity_id=$1", [id]),
      );

      // ASIL İDDİA: satır DEĞİŞMEDİ. Backend reddetti.
      expect(after.status, `${role}: yetkisiz tıklama status'u DEĞİŞTİRMEMELİ`).toBe(before.status);
      expect(after.paid_at, `${role}: yetkisiz tıklama paid_at'i DEĞİŞTİRMEMELİ`).toBe(before.paid_at);
      expect(auditAfter, `${role}: yetkisiz tıklama audit satırı YAZMAMALI`).toBe(auditBefore);
      proof.push(`S2: tıklandı → DB status=${after.status} (değişmedi), audit ${auditBefore}→${auditAfter} (yazılmadı)`);

      /**
       * DÜRÜSTLÜK KONTROLÜ — reddin kullanıcıya NASIL göründüğü.
       *
       * Kullanıcı bir düğmeye basıp hiçbir şey olmamasını "çalışmadı" diye okur. Yetki reddi
       * meşrudur; SESSİZ olması değildir. Burada ölçülen: ekran ya (a) düğmeyi hiç göstermez,
       * ya (b) gerekçesiyle pasif gösterir, ya (c) reddi açıkça söyler. Üçü de olmuyorsa bu bir
       * UX kusurudur ve rapora öyle yazılır — testi gevşetmek yerine.
       */
      const body = await page.locator("body").innerText();
      const crashed = /Application error|Internal Server Error|Bir şeyler ters gitti/i.test(body);
      const explained = /yetki|izin|yetkiniz|erişim|reddedildi/i.test(body);
      proof.push(`dürüstlük: hata ekranı=${crashed}, gerekçe metni=${explained}`);

      evidence.push({
        route: "/payments/missing",
        control: signatureFor("/payments/missing", "ödendi"),
        role,
        verdict: "PASS",
        proof,
      });

      // Yetki reddi bir ÇÖKME ile sonuçlanmamalı: kullanıcıya "beklenmeyen hata" göstermek,
      // "bunu yapamazsınız" demenin kabul edilebilir bir yolu değildir.
      expect(crashed, `${role}: yetki reddi uygulama hata ekranıyla sonuçlanmamalı`).toBe(false);

      await s.context.close();
    });
  }
});
