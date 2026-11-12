/**
 * Telegram Ops CLI — read the bot's state, and return it to polling mode (Faz 42 / B2).
 *
 * Two commands, both talking only to api.telegram.org with the bot's own token:
 * - info            bot identity and the webhook registration Telegram currently holds
 * - delete-webhook  drop any registered webhook so `scripts/ops/telegram-assistant-worker.ts` can receive updates
 *
 * Usage: pnpm exec tsx scripts/ops/telegram-ops.ts [info|delete-webhook]
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

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
    console.log(`Yetkili Chat ID: ${chatId ? "tanımlı" : "Tanımlı değil"}`);

    const webhook = await tgApi("getWebhookInfo");
    console.log("\n=== Webhook Bilgisi ===");
    if (!webhook.ok) {
      console.error("Webhook bilgisi alınamadı:", webhook);
      return;
    }
    const info = webhook.result;
    if (info.url) {
      console.log(`Kayıtlı URL:    ${info.url}`);
      console.log("UYARI: Bir webhook kayıtlı. TypeScript Telegram işçisi (polling) bu durumda güncelleme alamaz;");
      console.log("       'delete-webhook' ile kaldırın.");
    } else {
      console.log("Kayıtlı URL:    (yok — polling modu, beklenen durum)");
    }
    console.log(`Bekleyen Güncelleme: ${info.pending_update_count}`);
    if (info.last_error_date) {
      console.log(`Son Hata Tarihi: ${new Date(info.last_error_date * 1000).toLocaleString("tr-TR")}`);
      console.log(`Son Hata Mesajı: ${info.last_error_message}`);
    }
  } catch (err: unknown) {
    console.error("Telegram API çağrısı başarısız:", err instanceof Error ? err.message : err);
  }
}

async function deleteWebhook() {
  console.log("Webhook kaldırılıyor (Polling moduna geçiş — bekleyen mesajlar korunur)...");
  const res = await tgApi("deleteWebhook", { drop_pending_updates: false });
  if (res.ok) {
    console.log("BAŞARILI: Webhook kaldırıldı. Artık 'pnpm ops:telegram:worker' polling ile çalışabilir.");
  } else {
    console.error("BAŞARISIZ:", res);
  }
}

async function main() {
  const command = process.argv[2] ?? "info";

  switch (command) {
    case "info":
      await showInfo();
      break;
    case "delete-webhook":
      await deleteWebhook();
      break;
    default:
      console.log("Kullanılabilir komutlar: info, delete-webhook");
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
