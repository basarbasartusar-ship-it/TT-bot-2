import os
import random
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    ContextTypes,
    CommandHandler,
)
from openai import OpenAI

# =========================
# CONFIG
# =========================
BOT_TOKEN = os.getenv("BOT_TOKEN", "YOUR_TELEGRAM_BOT_TOKEN")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "YOUR_OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5")

client = OpenAI(api_key=OPENAI_API_KEY)

# Used to reduce repeats during the current bot run.
used_names = set()


# =========================
# MAIN MENU
# =========================
def main_menu():
    keyboard = [
        [
            InlineKeyboardButton("📤 Upload Image", callback_data="upload"),
            InlineKeyboardButton("🔗 My Links", callback_data="links"),
        ],
        [
            InlineKeyboardButton("✅ TikTok Video", callback_data="tiktok"),
            InlineKeyboardButton("✅ Facebook Video", callback_data="facebook"),
        ],
        [
            InlineKeyboardButton("✅ YouTube Video", callback_data="youtube"),
            InlineKeyboardButton("✅ AI Image", callback_data="ai_image"),
        ],
        [
            InlineKeyboardButton(
                "👩‍🎤 AI Username & Nickname",
                callback_data="ai_names",
            ),
        ],
        [
            InlineKeyboardButton("✏️ AI Edit Image", callback_data="ai_edit"),
        ],
        [
            InlineKeyboardButton("⚙️ Settings", callback_data="settings"),
            InlineKeyboardButton("💡 Help", callback_data="help"),
        ],
    ]
    return InlineKeyboardMarkup(keyboard)


# =========================
# AI NAME GENERATOR
# =========================
def generate_names():
    old_names = list(used_names)[-100:]

    prompt = f"""
Generate 10 NEW TikTok username + stylish nickname pairs.

Theme:
- feminine / girl aesthetic
- cute, stylish, modern
- suitable for TikTok
- English/Latin characters
- usernames can use letters, numbers, dots or underscores
- nicknames can use stylish Unicode characters
- do NOT use real people's identities
- do NOT generate offensive, sexual, hateful or discriminatory names
- every pair must be different
- do not repeat anything from the previous list

Previous generated usernames/nicknames to avoid:
{old_names}

Return ONLY this format:

1. Username: example
   Nickname: example

2. Username: example
   Nickname: example

...
10. Username: example
   Nickname: example
"""

    response = client.responses.create(
        model=OPENAI_MODEL,
        input=prompt,
    )

    text = response.output_text.strip()

    # Save simple duplicate fingerprints.
    for line in text.splitlines():
        line_low = line.lower().strip()
        if line_low.startswith("username:"):
            used_names.add(line_low.replace("username:", "", 1).strip())
        elif line_low.startswith("nickname:"):
            used_names.add(line_low.replace("nickname:", "", 1).strip())

    return text


# =========================
# CALLBACK HANDLER
# =========================
async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    if query.data == "ai_names":
        await query.edit_message_text(
            "🤖 AI নতুন TikTok Username & Stylish Nickname তৈরি করছে..."
        )

        try:
            result = generate_names()

            keyboard = [
                [
                    InlineKeyboardButton(
                        "🔄 Generate Again",
                        callback_data="ai_names",
                    )
                ],
                [
                    InlineKeyboardButton(
                        "🏠 Main Menu",
                        callback_data="main_menu",
                    )
                ],
            ]

            await query.message.reply_text(
                "✨ AI TikTok Username & Stylish Nickname\n\n"
                + result,
                reply_markup=InlineKeyboardMarkup(keyboard),
            )

        except Exception as e:
            print("AI error:", e)
            await query.message.reply_text(
                "❌ নাম তৈরি করতে সমস্যা হয়েছে।\n"
                "API key/model ঠিক আছে কিনা দেখো।"
            )

    elif query.data == "main_menu":
        await query.message.reply_text(
            "🏠 Main Menu",
            reply_markup=main_menu(),
        )

    else:
        await query.message.reply_text(
            "এই অপশনটি তোমার existing bot code-এর সাথে connect করতে হবে।",
            reply_markup=main_menu(),
        )


# =========================
# /START
# =========================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Welcome!\n\nনিচের মেনু থেকে একটি অপশন বেছে নাও:",
        reply_markup=main_menu(),
    )


# =========================
# RUN BOT
# =========================
def main():
    if BOT_TOKEN == "YOUR_TELEGRAM_BOT_TOKEN":
        raise ValueError("BOT_TOKEN সেট করো।")

    if OPENAI_API_KEY == "YOUR_OPENAI_API_KEY":
        raise ValueError("OPENAI_API_KEY সেট করো।")

    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(button_handler))

    print("Bot is running...")
    app.run_polling()


if __name__ == "__main__":
    main()
