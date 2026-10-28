-- import_rows.mapping_status: 'blocked_by_parent' üyesi.
--
-- ═══ NEDEN ═══
--
-- Standart Import V2'de bazı sayfalar başka bir sayfanın kaydına bağlıdır: taksit → kredi
-- (04→03), banka hareketi → hesap (07→06), fatura/sipariş → proje (08/09→11). Eşleyici alt
-- kaydın üst kaydını DEFTERDEN (import_external_keys) buluyordu; defter geçmişi bilir, bu
-- dosyayı bilmez.
--
-- Sonucu sessiz ve ağırdı: kredi satırı bu dosyada reddedilmişse (ör. EUR — finans toplama
-- kısıtı) ama aynı kod önceki bir import'tan defterde duruyorsa, taksitler ESKİ krediye
-- bağlanıp normal yazılıyor, vade akışına ve nakit tahminine giriyordu. Kullanıcı "kredim
-- reddedildi" mesajını görüyor, taksitlerinin toplamlara girdiğini görmüyordu.
--
-- Parser artık üst kaydı aynı dosyada kabul edilmemiş alt satırı `blocked_by_parent` olarak
-- işaretliyor ve eşleyici o satırı yazmıyor. Bu migration o durumun veritabanı yarısı;
-- TypeScript yarısı (parser.ts RowStatus, mapper.ts mappingStatusFor) aynı commit'te.
--
-- ═══ NEDEN AYRI BİR DEĞER ═══
--
-- 'rejected' YANLIŞ olurdu: satırın kendisi sözleşmeye uyuyor. 'needs_review' de yanlış:
-- insanın kabul edebileceği bir şey yok — üst kayıt düzeltilmeden bu satır yazılamaz.
-- Kullanıcının yapacağı iş farklı (bu satırı değil, üst kaydı düzeltmek) ve inceleme
-- ekranı bunu ayırt edebilmeli. Üç durumu tek kovaya koymak "hangi satırı düzelteyim?"
-- sorusunu cevapsız bırakırdı.
--
-- ═══ İLERİ YÖNLÜ ═══
--
-- 0089 düzenlenmedi; o migration uygulanmış veritabanlarında duruyor. Bu dosya CHECK'i
-- yeniden kurar ve 0089'un tüm üyelerini korur. Varlık kontrolü `conrelid` ile gerçek
-- tabloya bağlı (0090 hijyen kuralı): kısıt adları veritabanı genelinde eşsiz değildir.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.import_rows'::regclass and conname = 'import_rows_mapping_status_check'
  ) then
    alter table public.import_rows drop constraint import_rows_mapping_status_check;
  end if;

  alter table public.import_rows
    add constraint import_rows_mapping_status_check check (mapping_status in (
      'unmapped', 'mapped', 'ignored', 'needs_review',
      -- Faz V2 (0089). Sözleşmeye uymadığı için hiç yazılmamış satır.
      'rejected',
      -- Faz V2.4 (0091). Kendisi sağlam, üst kaydı bu dosyada kabul edilmediği için yazılmamış satır.
      'blocked_by_parent'
    ));
end $$;
