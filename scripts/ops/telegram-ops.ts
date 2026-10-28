/**
 * Telegram Ops CLI (Faz 2)
 *
 * Provides operators with essential management tools for the Telegram integration:
 * - inspect bot status and webhook state (info)
 * - register a webhook URL with secret token (set-webhook)
 * - remove webhook registration to restore polling mode (delete-webhook)
 * - send a live test alert to verify delivery pipeline (test-alert)
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { telegramTransport } from "../../src/lib/reminders/transport";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
const secret = process.env.TELEGRAM_INTERNAL_API_KEY?.trim();

function requireToken(): string {
  if (!token) {
    console.error("HATA: TELEGRAM_BOT_TOKEN ortam değişkeni tanımlı değil.");
    process.exit(1);
  }
  return token;
}

async function tgApi(method: string, body?: Record<string, unknown>) {
  const botToken = requireToken();
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  return res.json();
}

async function showInfo() {
  console.log("=== Telegram Bot Durumu ===");
  try {
    const me = await tgApi("getMe");
    if (!me.ok) {
      console.error("Bot bilgisi alınamadı:", me);
      return;
    }
    console.log(`Bot Adı:        ${me.result.first_name} (@${me.result.username})`);
    console.log(`Bot ID:         ${me.result.id}`);
    console.log(`Yetkili Chat ID: ${chatId ?? "Tanımlı değil"}`);

    const webhook = await tgApi("getWebhookInfo");
    console.log("\n=== Webhook Bilgisi ===");
    if (!webhook.ok) {
      console.error("Webhook bilgisi alınamadı:", webhook);
      return;
    }
    const info = webhook.result;
    console.log(`Kayıtlı URL:    ${info.url || "(Tanımlı değil - Polling modunda çalışabilir)"}`);
    console.log(`Bekleyen Güncelleme: ${info.pending_update_count}`);
    if (info.last_error_date) {
      console.log(`Son Hata Tarihi: ${new Date(info.last_error_date * 1000).toLocaleString("tr-TR")}`);
      console.log(`Son Hata Mesajı: ${info.last_error_message}`);
    }
  } catch (err: unknown) {
    console.error("Telegram API çağrısı başarısız:", err instanceof Error ? err.message : err);
  }
}

async function setWebhook(url: string) {
  if (!url.startsWith("https://")) {
    console.error("HATA: Telegram webhook URL'si mutlaka HTTPS olmalıdır (ör: https://nakit.sirketiniz.com/api/telegram/webhook).");
    process.exit(1);
  }
  console.log(`Webhook kaydediliyor: ${url}`);
  const payload: Record<string, unknown> = {
    url,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  };
  if (secret) {
    payload.secret_token = secret;
    console.log("Webhook gizli anahtarı (secret_token) otomatik eklendi.");
  }
  const res = await tgApi("setWebhook", payload);
  if (res.ok) {
    console.log("BAŞARILI: Webhook kaydedildi.", res.description ?? "");
  } else {
    console.error("BAŞARISIZ:", res);
  }
}

async function deleteWebhook() {
  console.log("Webhook kaldırılıyor (Polling moduna geçiş)...");
  const res = await tgApi("deleteWebhook", { drop_pending_updates: true });
  if (res.ok) {
    console.log("BAŞARILI: Webhook kaldırıldı. Artık 'python bot.py' veya polling motoru kullanılabilir.");
  } else {
    console.error("BAŞARISIZ:", res);
  }
}

async function testAlert(text: string) {
  if (!chatId) {
    console.error("HATA: TELEGRAM_CHAT_ID tanımlı değil.");
    process.exit(1);
  }
  console.log(`Test uyarısı gönderiliyor (Hedef Chat ID: ${chatId})...`);
  const transport = telegramTransport();
  const res = await transport.send(text);
  if (res.ok) {
    console.log("BAŞARILI: Telegram uyarısı başarıyla iletildi!");
  } else {
    console.error("BAŞARISIZ: Telegram uyarısı iletilemedi:", res.error);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "info";

  switch (command) {
    case "info":
      await showInfo();
      break;
    case "set-webhook":
      if (!args[1]) {
        console.error("Kullanım: pnpm exec tsx scripts/ops/telegram-ops.ts set-webhook https://domain.com/api/telegram/webhook");
        process.exit(1);
      }
      await setWebhook(args[1]);
      break;
    case "delete-webhook":
      await deleteWebhook();
      break;
    case "test-alert":
      await testAlert(args[1] ?? "MAS Nakit Radar Faz 2 Test Mesajı: Telegram entegrasyonu başarıyla devrede.");
      break;
    default:
      console.log("Kullanılabilir komutlar: info, set-webhook <url>, delete-webhook, test-alert [mesaj]");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
