-- Seed data (implementation.md §9 lists + calculation-rules thresholds + reminder rules)

insert into public.categories (name, domain, sort_order) values
 ('Kredi','loan',10),('Kredi Kartı','payment',20),('Çek','check',30),('Kira','payment',40),
 ('Telefon','payment',50),('İnternet','payment',60),('Elektrik/Su','payment',70),
 ('Alarm/Güvenlik','payment',80),('Cari Ödeme','cashflow',90),('Cari Gelir','cashflow',100),
 ('Banka/Hesap','cashflow',110),('Yemek','cost',120),('Yol','cost',130),('Personel','cost',140),
 ('Sigorta','cost',150),('Vergi','tax',160),('Diğer','other',170),('Bilinmiyor','other',180);

insert into public.parties (name, normalized_name, party_type) values
 ('MAS','mas','company'),
 ('Akon','akon','customer'),('Metsan','metsan','customer'),('Hpt','hpt','customer'),('Egemet','egemet','customer'),
 ('Elit','elit','vendor'),('Çağdaş','çağdaş','vendor'),('Akbaş','akbaş','vendor'),
 ('Halk','halk','bank'),('Deniz','deniz','bank'),('Vinov','vinov','bank'),
 ('Telekom','telekom','provider'),('Süperbox','süperbox','provider'),('Pronet','pronet','provider'),
 ('Armağan','armağan','person'),('Esma','esma','person');

insert into public.cash_accounts (name, account_type, provider_party_id) values
 ('Kasa','cash',null),
 ('HESAP Halk','bank_account',(select id from public.parties where normalized_name='halk' and party_type='bank')),
 ('Halk Business','credit_card',(select id from public.parties where normalized_name='halk' and party_type='bank')),
 ('Halk KK - Paraf','credit_card',(select id from public.parties where normalized_name='halk' and party_type='bank')),
 ('Deniz','bank_account',(select id from public.parties where normalized_name='deniz' and party_type='bank')),
 ('Vinov','check_account',(select id from public.parties where normalized_name='vinov' and party_type='bank'));

insert into public.settings (key, value, description) values
 ('large_payment_threshold_try','50000','Büyük ödeme eşiği'),
 ('critical_payment_threshold_try','100000','Kritik ödeme eşiği'),
 ('same_day_cluster_count','3','Aynı güne yığılma eşiği'),
 ('negative_cash_threshold_try','0','Negatif kasa eşiği'),
 ('high_customer_concentration_ratio','0.40','Müşteri konsantrasyon eşiği'),
 ('high_bank_exposure_ratio','0.40','Banka exposure eşiği'),
 ('timezone','"Europe/Istanbul"','Rapor/hatırlatma saat dilimi');

insert into public.reminders (name, target_kind, offset_days, channel) values
 ('7 gün önce — hazırlık','payment_instance',7,'telegram'),
 ('3 gün önce — nakit hazır mı','payment_instance',3,'telegram'),
 ('1 gün önce — yarın ödeme','payment_instance',1,'telegram'),
 ('Ödeme günü — bugün','payment_instance',0,'telegram'),
 ('1 gün sonra — ödendi mi','payment_instance',-1,'telegram');
