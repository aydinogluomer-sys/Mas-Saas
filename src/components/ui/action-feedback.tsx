/**
 * AKSİYON GERİ BİLDİRİMİ — bir server action REDDETTİĞİNDE kullanıcının gördüğü şey.
 *
 * ═══ NE ÖLÇÜLDÜ ═══
 *
 * `src/app/(dashboard)/radar/actions.ts` başarısız bir mutasyonu şöyle bitirir:
 *
 *     errorRedirect(backTo, message)
 *       → redirect(`${backTo}?error=${encodeURIComponent(message)}`)
 *
 * Yani hata DOĞRU ÜRETİLİYOR ve URL'e yazılıyor. Ama `backTo` hedeflerinin hiçbiri o parametreyi
 * OKUMUYORDU. Üretim sunucusunda birebir gözlendi (viewer, /payments/missing, "ödendi"):
 *
 *     POST yanıtı            303 /payments/missing
 *     varılan URL            /payments/missing?error=instance%20not%20found
 *     main metni değişti mi  HAYIR
 *     toast / alert          yok
 *     konsol hatası          yok
 *
 * Kullanıcı düğmeye basıyor, sayfa yenileniyor, HİÇBİR ŞEY söylenmiyor ve hiçbir şey değişmiyor.
 * Bu, denetimin aradığı "sessiz başarısızlık" sınıfının ta kendisi: repoda 28 yerde `?error=`
 * üretiliyor, yalnız 13 sayfa okuyordu.
 *
 * ═══ NEDEN TOAST DEĞİL ═══
 *
 * Toast bir istemci bileşeni ister ve kaybolur. Buradaki hata bir REDDEDİLMİŞ FİNANSAL İŞLEMDİR;
 * kullanıcı ekrandan ayrılana kadar durmalı ve sayfa yenilendiğinde de görünmeli. Sunucuda
 * render edilen kalıcı bir şerit, hem JS'siz çalışır hem de `?error=` URL'de durduğu sürece
 * görünür kalır — yani gösterilen şey ile adres çubuğundaki gerçek asla ayrışmaz.
 */

export function ActionFeedback({ error, flash }: { error?: string; flash?: string }) {
  if (!error && !flash) return null;
  return (
    <>
      {error && (
        <p role="alert" className="border border-neg bg-neg/10 p-2 text-sm text-neg" data-action-error>
          İşlem tamamlanmadı: {error}
        </p>
      )}
      {flash && (
        <p role="status" className="border border-pos bg-pos/10 p-2 text-sm text-pos" data-action-flash>
          {flash}
        </p>
      )}
    </>
  );
}
