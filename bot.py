"""MAS Nakit Radar — read-only Telegram assistant (long polling).

Runs on the same machine as the MAS app. It long-polls Telegram (no webhook, so no public HTTPS
endpoint exists), answers only the owner's chat (TELEGRAM_CHAT_ID), and forwards questions to the
local read-only endpoint /api/telegram/assistant with the shared TELEGRAM_INTERNAL_API_KEY. It
never writes anything: there are no approval buttons and no mini-app (Wave 0 removed the
Telegram Mini App — it needed a public HTTPS URL and carried write buttons).

Dependencies are pinned in bot.requirements.txt.
"""

import logging
import os
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from dotenv import load_dotenv
from telegram import Update
from telegram.error import InvalidToken
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env.local")

TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
ALLOWED_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
INTERNAL_API_KEY = os.getenv("TELEGRAM_INTERNAL_API_KEY", "").strip()
MAS_APP_BASE_URL = os.getenv(
    "MAS_APP_BASE_URL",
    "http://127.0.0.1:3000",
).strip().rstrip("/")
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)

logger = logging.getLogger("mas-telegram-bot")
# python-telegram-bot uses token-bearing Telegram URLs internally. INFO-level HTTP logs would
# print that credential verbatim, so third-party transport logs stay at warning or above.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("telegram").setLevel(logging.WARNING)


def validate_configuration() -> None:
    missing = []

    if not TOKEN:
        missing.append("TELEGRAM_BOT_TOKEN")

    if not ALLOWED_CHAT_ID:
        missing.append("TELEGRAM_CHAT_ID")

    if not INTERNAL_API_KEY:
        missing.append("TELEGRAM_INTERNAL_API_KEY")

    if missing:
        raise RuntimeError(
            "Eksik ortam değişkenleri: " + ", ".join(missing)
        )

    # Every request carries TELEGRAM_INTERNAL_API_KEY, and the answers carry financial figures.
    # Both may only travel to the app on THIS machine, so a base URL pointing anywhere else is a
    # configuration error, not a choice: refuse to start rather than send the key away.
    host = (urlsplit(MAS_APP_BASE_URL).hostname or "").lower()
    if host not in LOOPBACK_HOSTS:
        raise RuntimeError(
            "MAS_APP_BASE_URL yalnız bu makineyi gösterebilir "
            "(127.0.0.1, localhost veya ::1); servis anahtarı başka bir adrese gönderilmez."
        )


def is_authorized(update: Update) -> bool:
    if not update.effective_chat:
        return False

    return str(update.effective_chat.id) == ALLOWED_CHAT_ID


async def reject_unauthorized(update: Update) -> None:
    if update.message:
        await update.message.reply_text(
            "Bu botu kullanma yetkiniz bulunmuyor."
        )


async def start(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    if not is_authorized(update):
        await reject_unauthorized(update)
        return

    if not update.message:
        return

    await update.message.reply_text(
        "Merhaba!\n\n"
        "MAS SaaS Telegram asistanı aktif. Yalnız okur; kayıt eklemez, değiştirmez veya onaylamaz.\n\n"
        "Komutlar:\n"
        "• /durum - Sistem sağlık durumu\n"
        "• /cari Akon - Cari hesap özeti\n"
        "• /hareket Akon - Cari hareketler\n\n"
        "Doğrudan soru da sorabilirsiniz:\n"
        "• Toplam açık alacak ne kadar?\n"
        "• Toplam açık borç ne kadar?",
    )


async def durum(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    if not is_authorized(update):
        await reject_unauthorized(update)
        return

    if not update.message:
        return

    try:
        # `next dev` compiles /health lazily on its first request. A cold Windows filesystem can
        # legitimately take longer than ten seconds even though the app and DB are healthy.
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"{MAS_APP_BASE_URL}/health"
            )

        if response.status_code == 200:
            health = response.json()

            await update.message.reply_text(
                "🟢 MAS SaaS çalışıyor.\n"
                f"Uygulama: {health.get('app', 'bilinmiyor')}\n"
                f"Veritabanı: {health.get('db', 'bilinmiyor')}\n"
                f"Gecikme: {health.get('latencyMs', '?')} ms"
            )
            return

        await update.message.reply_text(
            f"🔴 MAS SaaS health kontrolü HTTP "
            f"{response.status_code} döndürdü."
        )

    except httpx.TimeoutException:
        logger.warning("MAS SaaS health kontrolü 30 saniyede yanıt vermedi")
        await update.message.reply_text(
            "🟠 MAS SaaS çalışıyor olabilir ancak health kontrolü zaman aşımına uğradı. "
            "Birkaç saniye sonra /durum komutunu yeniden deneyin."
        )

    except Exception:
        logger.exception("MAS SaaS health kontrolü başarısız")

        await update.message.reply_text(
            "🔴 MAS SaaS uygulamasına ulaşılamadı."
        )


async def ask_mas(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    if not is_authorized(update):
        await reject_unauthorized(update)
        return

    if not update.message or not update.message.text:
        return

    question = update.message.text.strip()

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{MAS_APP_BASE_URL}/api/telegram/assistant",
                headers={
                    "X-Telegram-Internal-Key": INTERNAL_API_KEY,
                },
                json={
                    "chatId": str(update.effective_chat.id),
                    "message": question,
                },
            )

        if response.status_code == 401:
            await update.message.reply_text(
                "MAS SaaS servis anahtarı kabul edilmedi."
            )
            return

        if response.status_code == 403:
            await update.message.reply_text(
                "Bu Telegram hesabı MAS SaaS için yetkili değil."
            )
            return

        if response.status_code != 200:
            await update.message.reply_text(
                f"MAS SaaS isteği başarısız oldu: "
                f"HTTP {response.status_code}"
            )
            return

        body = response.json()
        answer = body.get("answer")

        if not answer:
            await update.message.reply_text(
                "MAS SaaS geçerli bir cevap döndürmedi."
            )
            return

        await update.message.reply_text(answer)

    except httpx.TimeoutException:
        await update.message.reply_text(
            "MAS SaaS yanıt vermekte gecikti."
        )

    except Exception:
        logger.exception("MAS SaaS asistan isteği başarısız")

        await update.message.reply_text(
            "MAS SaaS bağlantısında beklenmeyen bir hata oluştu."
        )


def main() -> None:
    validate_configuration()

    app = ApplicationBuilder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("durum", durum))
    app.add_handler(CommandHandler("cari", ask_mas))
    app.add_handler(CommandHandler("hareket", ask_mas))

    app.add_handler(
        MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            ask_mas,
        )
    )

    print("MAS SaaS Telegram Bot aktif ve komut bekliyor...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    try:
        main()
    except InvalidToken:
        print(
            "Telegram tokenı reddedildi. BotFather'dan yeni token üretip "
            ".env.local içindeki TELEGRAM_BOT_TOKEN değerini güncelleyin."
        )
        raise SystemExit(1)
