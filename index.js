// create by https://t.me/infinity_codex
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cron = require("node-cron");
const Database = require("better-sqlite3");
const { Telegraf, Markup } = require("telegraf");
const ytdl = require("@distube/ytdl-core");

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.TOKEN;
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const IMAGE_API_BASE = process.env.IMAGE_API_BASE || "https://host.tscv.workers.dev";
const IMAGE_API_KEY = process.env.IMAGE_API_KEY;
// Render's external URL is available even when no persistent disk is attached.
// Keep the default writable on every Render plan; set DATA_DIR=/var/data only
// when a persistent disk is mounted at /var/data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATABASE_FILE = path.join(DATA_DIR, "image-url-bot.sqlite");

if (!TOKEN) {
  throw new Error("TOKEN is required. Add it to Render Environment Variables or .env.");
}
if (!IMAGE_API_KEY) {
  throw new Error("IMAGE_API_KEY is required. Add it to Render Environment Variables or .env.");
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DATABASE_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    is_banned INTEGER DEFAULT 0,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id TEXT UNIQUE,
    url TEXT NOT NULL,
    owner_telegram_id INTEGER NOT NULL,
    caption TEXT,
    category TEXT DEFAULT 'general',
    expires_at DATETIME,
    file_size INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_deleted INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    telegram_id INTEGER PRIMARY KEY,
    default_expiry TEXT DEFAULT 'never',
    notify_expiry INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS broadcast_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT,
    sent_count INTEGER,
    failed_count INTEGER,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    telegram_id INTEGER PRIMARY KEY,
    active_message_id INTEGER,
    state TEXT DEFAULT 'idle',
    temp_data TEXT
  );
`);
db.prepare("INSERT OR IGNORE INTO bot_settings (key, value) VALUES ('bot_status', 'on')").run();
db.prepare(
  "INSERT OR IGNORE INTO bot_settings (key, value) VALUES ('maintenance_message', 'The bot is temporarily under maintenance. Please try again soon.')",
).run();

const bot = new Telegraf(TOKEN);
const app = express();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }) + " UTC";
}

function boldUiText(text) {
  return String(text)
    .split("\n")
    .map((line) => {
      if (!line.trim() || /<[^>]+>/.test(line)) return line;
      return `<b>${line}</b>`;
    })
    .join("\n");
}

function buttonIcon(text, style) {
  const value = String(text).toLowerCase();
  const matches = [
    [/upload/, "📤"],
    [/my links|link/, "🔗"],
    [/setting/, "⚙️"],
    [/help/, "💡"],
    [/admin/, "🛡️"],
    [/back|go back/, "↩️"],
    [/cancel|no,/, "❌"],
    [/delete|ban/, "🗑️"],
    [/copy/, "📋"],
    [/refresh/, "🔄"],
    [/broadcast|send to all/, "📣"],
    [/statistics|stats/, "📊"],
    [/search/, "🔎"],
    [/expiry|never|day|custom|default/, "⏳"],
    [/skip/, "⏭️"],
    [/new/, "✨"],
    [/edit|change/, "✏️"],
    [/prev/, "◀️"],
    [/next/, "▶️"],
  ];
  return matches.find(([pattern]) => pattern.test(value))?.[1] || ({ success: "✅", danger: "❌", primary: "▫️" }[style] || "▫️");
}

function btn(text, callbackData, style = "primary") {
  const safeStyle = ["primary", "success", "danger"].includes(style) ? style : "primary";
  return { ...Markup.button.callback(`${buttonIcon(text, safeStyle)} ${text}`, callbackData), style: safeStyle };
}

function keyboard(rows) {
  return Markup.inlineKeyboard(rows);
}

function isAdmin(telegramId) {
  return Number(getSetting("admin_telegram_id", "")) === Number(telegramId);
}

function claimFirstAdmin(telegramId) {
  const result = db
    .prepare("INSERT OR IGNORE INTO bot_settings (key, value) VALUES ('admin_telegram_id', ?)")
    .run(String(telegramId));
  return result.changes === 1 || isAdmin(telegramId);
}

function getSetting(key, fallback = null) {
  return db.prepare("SELECT value FROM bot_settings WHERE key = ?").get(key)?.value ?? fallback;
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES (?, ?)").run(key, String(value));
}

function getSession(telegramId) {
  const row = db.prepare("SELECT * FROM sessions WHERE telegram_id = ?").get(telegramId);
  if (!row) return { telegram_id: telegramId, active_message_id: null, state: "idle", temp_data: {} };
  let tempData = {};
  try {
    tempData = row.temp_data ? JSON.parse(row.temp_data) : {};
  } catch {
    tempData = {};
  }
  return { ...row, temp_data: tempData };
}

function saveSession(telegramId, patch = {}) {
  const current = getSession(telegramId);
  const next = {
    active_message_id: patch.active_message_id ?? current.active_message_id,
    state: patch.state ?? current.state,
    temp_data: patch.temp_data ?? current.temp_data,
  };
  db.prepare(`
    INSERT INTO sessions (telegram_id, active_message_id, state, temp_data)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      active_message_id = excluded.active_message_id,
      state = excluded.state,
      temp_data = excluded.temp_data
  `).run(telegramId, next.active_message_id, next.state, JSON.stringify(next.temp_data || {}));
  return { telegram_id: telegramId, ...next };
}

function clearSession(telegramId) {
  return saveSession(telegramId, { state: "idle", temp_data: {} });
}

function registerUser(ctx) {
  const user = ctx.from;
  if (!user) return;
  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_active_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_active_at = CURRENT_TIMESTAMP
  `).run(user.id, user.username || null, user.first_name || null);
  db.prepare("INSERT OR IGNORE INTO user_settings (telegram_id) VALUES (?)").run(user.id);
  saveSession(user.id);
}

function userIsBanned(telegramId) {
  return Boolean(db.prepare("SELECT is_banned FROM users WHERE telegram_id = ?").get(telegramId)?.is_banned);
}

async function sendScreen(chatId, text, rows = [], ctx = null) {
  const session = getSession(chatId);
  const extra = {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(rows.length ? keyboard(rows) : {}),
  };
  if (session.active_message_id) {
    try {
      await bot.telegram.editMessageText(chatId, session.active_message_id, undefined, boldUiText(text), extra);
      return session.active_message_id;
    } catch (error) {
      if (!String(error?.description || error?.message).includes("message is not modified")) {
      } else {
        return session.active_message_id;
      }
    }
  }
  const sent = await (ctx ? ctx.reply(boldUiText(text), extra) : bot.telegram.sendMessage(chatId, boldUiText(text), extra));
  saveSession(chatId, { active_message_id: sent.message_id });
  return sent.message_id;
}

async function sendFreshScreen(chatId, text, rows = [], ctx = null) {
  const extra = {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(rows.length ? keyboard(rows) : {}),
  };
  const sent = await (ctx ? ctx.reply(boldUiText(text), extra) : bot.telegram.sendMessage(chatId, boldUiText(text), extra));
  saveSession(chatId, { active_message_id: sent.message_id });
  return sent.message_id;
}

async function deleteIncoming(ctx) {
  if (ctx.message?.message_id) await ctx.deleteMessage().catch(() => {});
}

function mainMenuText(ctx) {
  const name = escapeHtml(ctx.from?.first_name || "there");
  return `<b>🖼️ ImageLink Bot</b>\n\n👋 Welcome, ${name}!\n\n✨ Turn any Telegram photo into a clean, shareable URL.\n\n📦 Your uploads stay organized here, with optional expiry controls.`;
}

function mainMenuRows(ctx) {
  const rows = [
    [btn("Upload Image", "upload:start", "success")],
    [btn("My Links", "links:0")],
    [btn("TikTok Video", "tiktok:start", "success")],
    [btn("Facebook Video", "fb:start", "success")],
    [btn("YouTube Video", "yt:start", "success")],
    [btn("Settings", "settings"), btn("Help", "help")],
  ];
  if (isAdmin(ctx.from?.id)) rows.push([btn("Admin Panel", "admin")]);
  return rows;
}

async function showMain(ctx, { fresh = false } = {}) {
  const chatId = ctx.chat.id;
  clearSession(chatId);
  if (fresh) await deleteIncoming(ctx);
  const render = fresh ? sendFreshScreen : sendScreen;
  await render(chatId, mainMenuText(ctx), mainMenuRows(ctx), ctx);
}

async function showUploadPhoto(ctx) {
  saveSession(ctx.chat.id, { state: "awaiting_photo", temp_data: {} });
  await sendScreen(
    ctx.chat.id,
    "<b>📤 Upload an image</b>\n\n📸 Send a photo here and I’ll turn it into a direct URL.",
    [[btn("Cancel", "menu", "danger")]],
    ctx,
  );
}

function expiryLabel(value) {
  return value ? formatDate(value) : "Permanent";
}

function uploadSummary(data) {
  return `<b>✅ Your image is live</b>\n\n🔗 <b>URL</b>\n<code>${escapeHtml(data.url)}</code>\n\n📝 <b>Caption:</b> ${escapeHtml(data.caption || "None")}\n⏳ <b>Expires:</b> ${expiryLabel(data.expiresAt)}`;
}

async function showCaptionStep(ctx) {
  saveSession(ctx.chat.id, { state: "awaiting_caption" });
  await sendScreen(
    ctx.chat.id,
    "<b>📝 Add a caption?</b>\n\n✍️ Send a short caption for this link, or skip it.",
    [[btn("Skip", "caption:skip"), btn("Cancel", "menu", "danger")]],
    ctx,
  );
}

async function showExpiryStep(ctx) {
  saveSession(ctx.chat.id, { state: "awaiting_expiry" });
  const defaultExpiry = db.prepare("SELECT default_expiry FROM user_settings WHERE telegram_id = ?").get(ctx.chat.id)?.default_expiry || "never";
  const defaultButton = defaultExpiry === "never"
    ? btn("Never", "expiry:never")
    : btn(`Use Default (${defaultExpiry})`, "expiry:default");
  await sendScreen(
    ctx.chat.id,
    `<b>⏳ Set an expiry?</b>\n\n♾️ Permanent is the default. Choose a timer or enter a duration like <code>12h</code> or <code>30d</code>.\n\n⚙️ Personal default: <b>${escapeHtml(defaultExpiry)}</b>`,
    [
      [btn("1 Day", "expiry:1d", "success"), btn("3 Days", "expiry:3d", "success"), btn("7 Days", "expiry:7d", "success")],
      [defaultButton, btn("Custom", "expiry:custom")],
      [btn("Cancel", "menu", "danger")],
    ],
    ctx,
  );
}

function parseExpiry(input) {
  const value = String(input || "").trim().toLowerCase();
  if (!value || value === "never" || value === "permanent") return null;
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d|day|days|w|week|weeks)$/);
  if (match) {
    const units = { m: 60000, min: 60000, h: 3600000, d: 86400000, day: 86400000, days: 86400000, w: 604800000, week: 604800000, weeks: 604800000 };
    return new Date(Date.now() + Number(match[1]) * units[match[2]]).toISOString();
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime()) && date.getTime() > Date.now()) return date.toISOString();
  return undefined;
}

async function finishUpload(ctx, data) {
  const result = db
    .prepare(`
      INSERT INTO links (image_id, url, owner_telegram_id, caption, expires_at, file_size)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(data.imageId, data.url, ctx.chat.id, data.caption || null, data.expiresAt || null, data.fileSize || null);
  clearSession(ctx.chat.id);
  saveSession(ctx.chat.id, { temp_data: { lastLinkId: Number(result.lastInsertRowid) } });
  await sendScreen(
    ctx.chat.id,
    uploadSummary(data),
    [
      [btn("Copy Link", `copy:${result.lastInsertRowid}`)],
      [btn("Back to Menu", "menu"), btn("Delete Now", `delete:${result.lastInsertRowid}`, "danger")],
    ],
    ctx,
  );
}

async function apiRequest(endpoint, options = {}) {
  const response = await fetch(`${IMAGE_API_BASE}${endpoint}`, {
    ...options,
    headers: { "X-API-Key": IMAGE_API_KEY, ...(options.headers || {}) },
  });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = raw;
  }
  if (!response.ok) throw new Error(`${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

async function showTiktokPrompt(ctx) {
  saveSession(ctx.chat.id, { state: "awaiting_tiktok_link", temp_data: {} });
  await sendScreen(
    ctx.chat.id,
    "<b>🎵 TikTok ভিডিও</b>\n\n🔗 TikTok ভিডিওর লিংকটা পাঠাও।",
    [[btn("Cancel", "menu", "danger")]],
    ctx,
  );
}

async function fetchTiktokVideoInfo(link) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(link)}`;
  const response = await fetch(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`TikTok API HTTP ${response.status}`);
  const body = await response.json();
  if (body.code !== 0 || !body.data) throw new Error(body.msg || "ভিডিও পাওয়া যায়নি।");
  const rawUrl = body.data.play || body.data.hdplay || body.data.wmplay;
  if (!rawUrl) throw new Error("ভিডিওর লিংক পাওয়া যায়নি।");
  const videoUrl = rawUrl.startsWith("http") ? rawUrl : `https://www.tikwm.com${rawUrl}`;
  return { videoUrl, title: body.data.title || "" };
}

async function fetchVideoBuffer(videoUrl) {
  const response = await fetch(videoUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`ভিডিও ডাউনলোড ব্যর্থ (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function finishTiktokDownload(ctx, link) {
  const statusMessageId = getSession(ctx.chat.id).active_message_id;
  const { videoUrl, title } = await fetchTiktokVideoInfo(link);
  const buffer = await fetchVideoBuffer(videoUrl);
  clearSession(ctx.chat.id);
  if (statusMessageId) {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
  }
  await ctx.replyWithVideo(
    { source: buffer, filename: "tiktok.mp4" },
    {
      caption: boldUiText(`<b>✅ ভিডিও রেডি (watermark ছাড়া)</b>\n\n🎵 ${escapeHtml(title || "TikTok video")}\n\n📥 ভিডিওর নিচের ডাউনলোড আইকনে চেপে গ্যালারিতে সেভ করো।`),
      parse_mode: "HTML",
      ...keyboard([[btn("Another Video", "tiktok:restart", "success"), btn("Back to Menu", "menu:media")]]),
    },
  );
}

async function showFacebookPrompt(ctx) {
  saveSession(ctx.chat.id, { state: "awaiting_fb_link", temp_data: {} });
  await sendScreen(
    ctx.chat.id,
    "<b>📘 Facebook ভিডিও</b>\n\n🔗 Facebook ভিডিওর (পাবলিক পোস্ট) লিংকটা পাঠাও।",
    [[btn("Cancel", "menu", "danger")]],
    ctx,
  );
}

async function fetchFacebookVideoInfo(link) {
  const response = await fetch(link, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Facebook পেজ খোলা যায়নি (HTTP ${response.status})`);
  const html = await response.text();
  const match =
    html.match(/"browser_native_hd_url":"([^"]+)"/) ||
    html.match(/"browser_native_sd_url":"([^"]+)"/) ||
    html.match(/hd_src:"([^"]+)"/) ||
    html.match(/sd_src:"([^"]+)"/) ||
    html.match(/"playable_url_quality_hd":"([^"]+)"/) ||
    html.match(/"playable_url":"([^"]+)"/);
  if (!match) throw new Error("ভিডিও লিংক পাওয়া যায়নি। পোস্টটা পাবলিক আছে কিনা চেক করো।");
  let videoUrl;
  try {
    videoUrl = JSON.parse(`"${match[1]}"`);
  } catch {
    videoUrl = match[1].replace(/\\\//g, "/");
  }
  return { videoUrl };
}

async function finishFacebookDownload(ctx, link) {
  const statusMessageId = getSession(ctx.chat.id).active_message_id;
  const { videoUrl } = await fetchFacebookVideoInfo(link);
  const buffer = await fetchVideoBuffer(videoUrl);
  clearSession(ctx.chat.id);
  if (statusMessageId) {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
  }
  await ctx.replyWithVideo(
    { source: buffer, filename: "facebook.mp4" },
    {
      caption: boldUiText(`<b>✅ ভিডিও রেডি</b>\n\n📥 ভিডিওর নিচের ডাউনলোড আইকনে চেপে গ্যালারিতে সেভ করো।`),
      parse_mode: "HTML",
      ...keyboard([[btn("Another Video", "fb:restart", "success"), btn("Back to Menu", "menu:media")]]),
    },
  );
}

async function showYoutubePrompt(ctx) {
  saveSession(ctx.chat.id, { state: "awaiting_yt_link", temp_data: {} });
  await sendScreen(
    ctx.chat.id,
    "<b>▶️ YouTube ভিডিও</b>\n\n🔗 YouTube ভিডিওর লিংকটা পাঠাও।",
    [[btn("Cancel", "menu", "danger")]],
    ctx,
  );
}

async function fetchYoutubeFormat(link) {
  if (!ytdl.validateURL(link)) throw new Error("এটা সঠিক YouTube লিংক মনে হচ্ছে না।");
  const info = await ytdl.getInfo(link);
  const format =
    ytdl.chooseFormat(info.formats, { quality: "18" }) ||
    ytdl.chooseFormat(info.formats, { filter: "audioandvideo", quality: "highest" });
  if (!format) throw new Error("ডাউনলোডযোগ্য ফরম্যাট পাওয়া যায়নি।");
  return { info, format };
}

function streamToBuffer(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        reject(new Error("ভিডিওটা ৪৫MB এর বেশি — Telegram-এ পাঠানো যাচ্ছে না। ছোট ভিডিও ট্রাই করো।"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function finishYoutubeDownload(ctx, link) {
  const statusMessageId = getSession(ctx.chat.id).active_message_id;
  const { info, format } = await fetchYoutubeFormat(link);
  const stream = ytdl.downloadFromInfo(info, { format });
  const buffer = await streamToBuffer(stream, 45 * 1024 * 1024);
  clearSession(ctx.chat.id);
  if (statusMessageId) {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
  }
  const title = info.videoDetails?.title || "YouTube video";
  await ctx.replyWithVideo(
    { source: buffer, filename: "youtube.mp4" },
    {
      caption: boldUiText(`<b>✅ ভিডিও রেডি</b>\n\n🎬 ${escapeHtml(title)}\n\n📥 ভিডিওর নিচের ডাউনলোড আইকনে চেপে গ্যালারিতে সেভ করো।`),
      parse_mode: "HTML",
      ...keyboard([[btn("Another Video", "yt:restart", "success"), btn("Back to Menu", "menu:media")]]),
    },
  );
}

async function uploadImage(buffer, filename, contentType) {
  const form = new FormData();
  const safeContentType = contentType?.startsWith("image/") ? contentType : "image/jpeg";
  const safeFilename = /\.(png|jpe?g|gif|webp)$/i.test(filename) ? filename : `${filename}.jpg`;
  form.append("file", new Blob([buffer], { type: safeContentType }), safeFilename);
  const body = await apiRequest("/upload", { method: "POST", body: form });
  const imageId = body.id || body.image_id || body.imageId || body.key;
  const url = body.url || body.cdn_url || `${IMAGE_API_BASE}/img/${imageId}`;
  if (!imageId || !url) throw new Error("Image API returned no image id or URL.");
  return { imageId, url };
}

async function deleteRemoteImage(imageId) {
  return apiRequest(`/delete/${encodeURIComponent(imageId)}`, { method: "DELETE" });
}

async function processPhoto(ctx) {
  registerUser(ctx);
  let session = getSession(ctx.chat.id);
  if (session.state !== "awaiting_photo") {
    saveSession(ctx.chat.id, { state: "awaiting_photo", temp_data: {} });
    session = getSession(ctx.chat.id);
  }
  await deleteIncoming(ctx);
  await sendScreen(ctx.chat.id, "<b>⏫ Uploading…</b>\n\n🔄 Fetching the Telegram file and creating your URL.", [], ctx);
  try {
    const photo = ctx.message.photo.at(-1);
    const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
    const response = await fetch(fileUrl.href || fileUrl);
    if (!response.ok) throw new Error(`Telegram file download failed with ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const uploaded = await uploadImage(buffer, `telegram-${ctx.from.id}-${Date.now()}.jpg`, "image/jpeg");
    saveSession(ctx.chat.id, {
      state: "awaiting_caption",
      temp_data: { ...session.temp_data, ...uploaded, fileSize: buffer.length },
    });
    await showCaptionStep(ctx);
  } catch (error) {
    await sendScreen(
      ctx.chat.id,
      `<b>⚠️ Upload failed</b>\n\n${escapeHtml(error.message)}\n\n🔁 Try sending the photo again.`,
      [[btn("Try Again", "upload:start", "success"), btn("Back to Menu", "menu")]],
      ctx,
    );
  }
}

function linkForUser(id, telegramId) {
  return db.prepare("SELECT * FROM links WHERE id = ? AND owner_telegram_id = ? AND is_deleted = 0").get(id, telegramId);
}

function linksPage(telegramId, page = 0) {
  return db
    .prepare("SELECT * FROM links WHERE owner_telegram_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 5 OFFSET ?")
    .all(telegramId, page * 5);
}

async function showLinks(ctx, page = 0) {
  const items = linksPage(ctx.chat.id, page);
  const count = db.prepare("SELECT COUNT(*) AS count FROM links WHERE owner_telegram_id = ? AND is_deleted = 0").get(ctx.chat.id).count;
  const rows = items.map((link) => [
    btn(`${(link.caption || "Untitled").slice(0, 24)} · ${String(link.created_at).slice(0, 10)}`, `link:${link.id}`),
  ]);
  const nav = [];
  if (page > 0) nav.push(btn("Prev", `links:${page - 1}`));
  if ((page + 1) * 5 < count) nav.push(btn("Next", `links:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([btn("Back to Menu", "menu")]);
  await sendScreen(ctx.chat.id, `<b>🔗 My Links</b>\n\n${count ? "📌 Select a link to view its details." : "📭 No links here yet. Upload your first image to get started."}`, rows, ctx);
}

async function showLinkDetail(ctx, id) {
  const link = linkForUser(id, ctx.chat.id);
  if (!link) {
    await sendScreen(ctx.chat.id, "<b>⚠️ Link unavailable</b>\n\n🗑️ It may have already been deleted.", [[btn("Back to List", "links:0")]], ctx);
    return;
  }
  await sendScreen(
    ctx.chat.id,
    `<b>📄 Link details</b>\n\n🔗 <b>URL</b>\n<code>${escapeHtml(link.url)}</code>\n\n📝 <b>Caption:</b> ${escapeHtml(link.caption || "None")}\n📅 <b>Uploaded:</b> ${formatDate(link.created_at)}\n⏳ <b>Expires:</b> ${expiryLabel(link.expires_at)}`,
    [
      [btn("Copy Link", `copy:${link.id}`)],
      [btn("Edit Caption", `editcaption:${link.id}`)],
      [btn("Change Expiry", `editexpiry:${link.id}`)],
      [btn("Delete", `deleteconfirm:${link.id}`, "danger")],
      [btn("Back to List", "links:0")],
    ],
    ctx,
  );
}

async function showSettings(ctx) {
  const settings = db.prepare("SELECT * FROM user_settings WHERE telegram_id = ?").get(ctx.chat.id) || { default_expiry: "never", notify_expiry: 1 };
  await sendScreen(
    ctx.chat.id,
    `<b>⚙️ Settings</b>\n\n⏳ <b>Default expiry:</b> ${escapeHtml(settings.default_expiry)}\n🔔 <b>Notify on auto-delete:</b> ${settings.notify_expiry ? "ON" : "OFF"}`,
    [
      [btn("Default Expiry", "settings:expiry")],
      [btn(`Notify on Auto-Delete: ${settings.notify_expiry ? "ON" : "OFF"}`, "settings:notify")],
      [btn("Back", "menu")],
    ],
    ctx,
  );
}

async function showHelp(ctx) {
  await sendScreen(
    ctx.chat.id,
    "<b>💡 Help</b>\n\n📤 <b>Upload:</b> tap Upload Image, then send a photo.\n📝 <b>Caption:</b> add a label to each image if you want.\n⏳ <b>Expiry:</b> every image gets its own independent expiry choice.\n\n✨ The bot keeps your interface in one edited card so your chat stays clean.",
    [[btn("Back to Menu", "menu")]],
    ctx,
  );
}

async function showAdmin(ctx, { fresh = false } = {}) {
  if (!isAdmin(ctx.from.id)) return showMain(ctx);
  const status = getSetting("bot_status", "on") === "on";
  const render = fresh ? sendFreshScreen : sendScreen;
  if (fresh) await deleteIncoming(ctx);
  await render(
    ctx.chat.id,
    `<b>🛡️ Admin Panel</b>\n\n🤖 Bot status: <b>${status ? "ON" : "OFF"}</b>\n🧰 Admins can manage availability, broadcasts, and users here.`,
    [
      [btn("Bot Statistics", "admin:stats"), btn(`Bot: ${status ? "ON" : "OFF"}`, "admin:toggle", status ? "success" : "danger")],
      [btn("Broadcast", "admin:broadcast")],
      [btn("User Management", "admin:users")],
      [btn("Back to Main Menu", "menu")],
    ],
    ctx,
  );
}

async function claimAdmin(ctx) {
  if (isAdmin(ctx.from.id)) {
    await showAdmin(ctx, { fresh: true });
    return;
  }
  if (getSetting("admin_telegram_id")) {
    await deleteIncoming(ctx);
    await sendScreen(
      ctx.chat.id,
      "<b>🔒 Admin is already assigned</b>\n\nOnly the first person who used <code>/admin</code> can access the admin panel.",
      [[btn("Back to Menu", "menu")]],
      ctx,
    );
    return;
  }
  claimFirstAdmin(ctx.from.id);
  await showAdmin(ctx, { fresh: true });
}

async function showAdminStats(ctx) {
  const totalUsers = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  const joinedToday = db.prepare("SELECT COUNT(*) AS count FROM users WHERE date(joined_at) = date('now')").get().count;
  const joinedWeek = db.prepare("SELECT COUNT(*) AS count FROM users WHERE joined_at >= datetime('now', '-7 days')").get().count;
  const totalLinks = db.prepare("SELECT COUNT(*) AS count FROM links").get().count;
  const activeLinks = db.prepare("SELECT COUNT(*) AS count FROM links WHERE is_deleted = 0").get().count;
  const storage = db.prepare("SELECT COALESCE(SUM(file_size), 0) AS bytes FROM links WHERE is_deleted = 0").get().bytes;
  let apiStats = "Unavailable";
  try {
    const stats = await apiRequest("/api/key-stats");
    apiStats = escapeHtml(JSON.stringify(stats));
  } catch (error) {
    apiStats = escapeHtml(error.message);
  }
  await sendScreen(
    ctx.chat.id,
    `<b>📊 Bot Statistics</b>\n\n👥 <b>Users</b>\nTotal: ${totalUsers}\nJoined today: ${joinedToday}\nJoined this week: ${joinedWeek}\n\n🔗 <b>Links</b>\nTotal: ${totalLinks}\nActive: ${activeLinks}\nStorage: ${(Number(storage) / 1024 / 1024).toFixed(2)} MB\n\n☁️ <b>Image API</b>\n<code>${apiStats.slice(0, 900)}</code>`,
    [[btn("Refresh", "admin:stats"), btn("Back", "admin")]],
    ctx,
  );
}

async function showAdminUsers(ctx, query = "", page = 0) {
  if (!isAdmin(ctx.from.id)) return showMain(ctx);
  const cleanQuery = String(query || "").trim();
  const filter = cleanQuery
    ? {
        sql: "WHERE CAST(telegram_id AS TEXT) = ? OR username LIKE ?",
        params: [cleanQuery, `%${cleanQuery.replace(/^@/, "")}%`],
      }
    : { sql: "", params: [] };
  const total = db.prepare(`SELECT COUNT(*) AS count FROM users ${filter.sql}`).get(...filter.params).count;
  const totalPages = Math.max(1, Math.ceil(total / 10));
  const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
  const users = db
    .prepare(`SELECT * FROM users ${filter.sql} ORDER BY last_active_at DESC LIMIT 10 OFFSET ?`)
    .all(...filter.params, safePage * 10);
  const rows = users.map((user) => [btn(`${user.first_name || user.username || user.telegram_id}${user.is_banned ? " · banned" : ""}`, `admin:user:${user.telegram_id}`)]);
  const navigation = [];
  if (safePage > 0) navigation.push(btn("Previous", `admin:users:page:${safePage - 1}`));
  if (safePage < totalPages - 1) navigation.push(btn("Next", `admin:users:page:${safePage + 1}`));
  if (navigation.length) rows.push(navigation);
  rows.push([btn("Search User", "admin:usersearch"), btn("Back", "admin")]);
  saveSession(ctx.chat.id, { temp_data: { adminUserQuery: cleanQuery, adminUserPage: safePage } });
  await sendScreen(
    ctx.chat.id,
    `<b>👥 User Management</b>\n\n${cleanQuery ? `🔎 Results for <code>${escapeHtml(cleanQuery)}</code>` : "🕘 Recent users"}\n📄 Page <b>${safePage + 1}/${totalPages}</b> · ${total} user${total === 1 ? "" : "s"}\n👤 10 users per page`,
    rows,
    ctx,
  );
}

async function showAdminUser(ctx, telegramId) {
  const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);
  if (!user) return showAdminUsers(ctx);
  const count = db.prepare("SELECT COUNT(*) AS count FROM links WHERE owner_telegram_id = ? AND is_deleted = 0").get(telegramId).count;
  await sendScreen(
    ctx.chat.id,
    `<b>👤 User</b>\n\n🆔 ID: <code>${user.telegram_id}</code>\n🔹 Username: @${escapeHtml(user.username || "none")}\n📅 Joined: ${formatDate(user.joined_at)}\n🔗 Active links: ${count}\n🚦 Status: <b>${user.is_banned ? "BANNED" : "ACTIVE"}</b>`,
    [[btn(user.is_banned ? "Unban" : "Ban", `admin:ban:${user.telegram_id}`, user.is_banned ? "success" : "danger")], [btn("Back", "admin:users:back")]],
    ctx,
  );
}

async function broadcastToUsers(message, ctx) {
  const users = db.prepare("SELECT telegram_id FROM users WHERE is_banned = 0").all();
  let sent = 0;
  let failed = 0;
  for (const user of users) {
    try {
      await bot.telegram.sendMessage(user.telegram_id, message);
      sent += 1;
    } catch {
      failed += 1;
    }
    await sleep(55);
  }
  db.prepare("INSERT INTO broadcast_log (message, sent_count, failed_count) VALUES (?, ?, ?)").run(message, sent, failed);
  clearSession(ctx.chat.id);
  await sendScreen(ctx.chat.id, `<b>✅ Broadcast complete</b>\n\n📨 Sent: ${sent}\n⚠️ Failed: ${failed}`, [[btn("Back to Admin", "admin")]], ctx);
}

function sessionInput(ctx, text) {
  const session = getSession(ctx.chat.id);
  return { session, text: String(text || "").trim() };
}

bot.use(async (ctx, next) => {
  if (ctx.from) registerUser(ctx);
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const command = ctx.message?.text?.split(/\s+/)[0]?.split("@")[0];
  const canClaimFirstAdmin = command === "/admin" && !getSetting("admin_telegram_id");
  if (!ctx.from || isAdmin(ctx.from.id) || canClaimFirstAdmin || getSetting("bot_status", "on") === "on") return next();
  if (userIsBanned(ctx.from.id)) return;
  const maintenance = getSetting("maintenance_message", "The bot is temporarily under maintenance.");
  await sendScreen(ctx.chat.id, `<b>🚧 Maintenance</b>\n\n${escapeHtml(maintenance)}`, [], ctx).catch(() => {});
});

bot.start((ctx) => showMain(ctx, { fresh: true }));
bot.command("admin", claimAdmin);
bot.command("upload", showUploadPhoto);
bot.command("links", (ctx) => showLinks(ctx));
bot.command("settings", showSettings);
bot.command("help", showHelp);

bot.action("menu", showMain);
bot.action("upload:start", showUploadPhoto);
bot.action("tiktok:start", showTiktokPrompt);
bot.action("tiktok:restart", async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  await showTiktokPrompt(ctx);
});
bot.action("menu:media", async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  await showMain(ctx, { fresh: true });
});
bot.action("fb:start", showFacebookPrompt);
bot.action("fb:restart", async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  await showFacebookPrompt(ctx);
});
bot.action("yt:start", showYoutubePrompt);
bot.action("yt:restart", async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  await showYoutubePrompt(ctx);
});
bot.action("links:0", (ctx) => showLinks(ctx, 0));
bot.action(/^links:(\d+)$/, (ctx) => showLinks(ctx, Number(ctx.match[1])));
bot.action("settings", showSettings);
bot.action("help", showHelp);
bot.action("admin", showAdmin);

bot.action("caption:skip", async (ctx) => {
  const session = getSession(ctx.chat.id);
  saveSession(ctx.chat.id, { temp_data: { ...session.temp_data, caption: null } });
  await showExpiryStep(ctx);
});
bot.action(/^expiry:(.+)$/, async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (ctx.match[1] === "custom") {
    saveSession(ctx.chat.id, { state: "awaiting_expiry" });
    await sendScreen(ctx.chat.id, "<b>🕒 Custom expiry</b>\n\n⌛ Send a duration like <code>12h</code>, <code>30d</code>, or an ISO date.", [[btn("Cancel", "menu", "danger")]], ctx);
    return;
  }
  let value = ctx.match[1] === "never" ? null : parseExpiry(ctx.match[1]);
  if (ctx.match[1] === "default") {
    const defaultExpiry = db.prepare("SELECT default_expiry FROM user_settings WHERE telegram_id = ?").get(ctx.chat.id)?.default_expiry || "never";
    value = defaultExpiry === "never" ? null : parseExpiry(defaultExpiry);
  }
  saveSession(ctx.chat.id, { temp_data: { ...session.temp_data, expiresAt: value } });
  await finishUpload(ctx, { ...session.temp_data, expiresAt: value });
});
bot.action(/^link:(\d+)$/, (ctx) => showLinkDetail(ctx, Number(ctx.match[1])));
bot.action(/^copy:(\d+)$/, async (ctx) => {
  const link = linkForUser(Number(ctx.match[1]), ctx.chat.id);
  if (link) await sendScreen(ctx.chat.id, `<b>📋 Copy this URL</b>\n\n<code>${escapeHtml(link.url)}</code>`, [[btn("Back to Link", `link:${link.id}`)]], ctx);
});
bot.action(/^deleteconfirm:(\d+)$/, async (ctx) => {
  await sendScreen(ctx.chat.id, "<b>🗑️ Delete this link?</b>\n\n⚠️ The remote image and saved record will be removed.", [[btn("Yes, Delete", `delete:${ctx.match[1]}`, "danger"), btn("No, Go Back", `link:${ctx.match[1]}`)]], ctx);
});
bot.action(/^delete:(\d+)$/, async (ctx) => {
  const link = linkForUser(Number(ctx.match[1]), ctx.chat.id);
  if (link) {
    try {
      await deleteRemoteImage(link.image_id);
    } catch {
    }
    db.prepare("UPDATE links SET is_deleted = 1 WHERE id = ?").run(link.id);
  }
  await sendScreen(ctx.chat.id, "<b>🗑️ Link deleted</b>\n\n✅ The image is no longer available from this bot.", [[btn("Back to Menu", "menu")]], ctx);
});
bot.action(/^editcaption:(\d+)$/, async (ctx) => {
  saveSession(ctx.chat.id, { state: "awaiting_edit_caption", temp_data: { linkId: Number(ctx.match[1]) } });
  await sendScreen(ctx.chat.id, "<b>✏️ Edit caption</b>\n\n📝 Send the new caption, or send <code>-</code> to clear it.", [[btn("Cancel", `link:${ctx.match[1]}`)]], ctx);
});
bot.action(/^editexpiry:(\d+)$/, async (ctx) => {
  saveSession(ctx.chat.id, { state: "awaiting_edit_expiry", temp_data: { linkId: Number(ctx.match[1]) } });
  await sendScreen(ctx.chat.id, "<b>⏳ Change expiry</b>\n\nChoose a new lifetime for this image.", [[btn("1 Day", "seteditexpiry:1d"), btn("3 Days", "seteditexpiry:3d"), btn("7 Days", "seteditexpiry:7d")], [btn("Never", "seteditexpiry:never"), btn("Custom", "seteditexpiry:custom")], [btn("Cancel", `link:${ctx.match[1]}`)]], ctx);
});
bot.action(/^seteditexpiry:(.+)$/, async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (ctx.match[1] === "custom") {
    saveSession(ctx.chat.id, { state: "awaiting_edit_expiry" });
    await sendScreen(ctx.chat.id, "<b>🕒 Custom expiry</b>\n\n⌛ Send a duration like <code>12h</code>, <code>30d</code>, or an ISO date.", [[btn("Cancel", `link:${session.temp_data.linkId}`)]], ctx);
    return;
  }
  const link = linkForUser(session.temp_data.linkId, ctx.chat.id);
  if (link) db.prepare("UPDATE links SET expires_at = ? WHERE id = ?").run(ctx.match[1] === "never" ? null : parseExpiry(ctx.match[1]), link.id);
  await showLinkDetail(ctx, session.temp_data.linkId);
});
bot.action("settings:notify", async (ctx) => {
  const current = db.prepare("SELECT notify_expiry FROM user_settings WHERE telegram_id = ?").get(ctx.chat.id)?.notify_expiry ?? 1;
  db.prepare("UPDATE user_settings SET notify_expiry = ? WHERE telegram_id = ?").run(current ? 0 : 1, ctx.chat.id);
  await showSettings(ctx);
});
bot.action("settings:expiry", async (ctx) => {
  saveSession(ctx.chat.id, { state: "awaiting_default_expiry" });
  await sendScreen(ctx.chat.id, "<b>⏳ Default expiry</b>\n\n⌛ Send <code>never</code>, <code>1d</code>, <code>3d</code>, or another duration.", [[btn("Cancel", "settings")]], ctx);
});

bot.action("admin:stats", showAdminStats);
bot.action("admin:toggle", async (ctx) => {
  setSetting("bot_status", getSetting("bot_status", "on") === "on" ? "off" : "on");
  await showAdmin(ctx);
});
bot.action("admin:broadcast", async (ctx) => {
  saveSession(ctx.chat.id, { state: "awaiting_broadcast" });
  await sendScreen(ctx.chat.id, "<b>📣 Broadcast</b>\n\n✍️ Send the message to broadcast to every non-banned user.", [[btn("Cancel", "admin", "danger")]], ctx);
});
bot.action("admin:users", (ctx) => showAdminUsers(ctx));
bot.action(/^admin:users:page:(\d+)$/, async (ctx) => {
  const session = getSession(ctx.chat.id);
  await showAdminUsers(ctx, session.temp_data.adminUserQuery || "", Number(ctx.match[1]));
});
bot.action("admin:users:back", async (ctx) => {
  const session = getSession(ctx.chat.id);
  await showAdminUsers(ctx, session.temp_data.adminUserQuery || "", session.temp_data.adminUserPage || 0);
});
bot.action("admin:usersearch", async (ctx) => {
  saveSession(ctx.chat.id, { state: "awaiting_user_search" });
  await sendScreen(ctx.chat.id, "<b>🔎 Search users</b>\n\n🆔 Send a Telegram ID or username.", [[btn("Cancel", "admin")]], ctx);
});
bot.action(/^admin:user:(\d+)$/, (ctx) => showAdminUser(ctx, Number(ctx.match[1])));
bot.action(/^admin:ban:(\d+)$/, async (ctx) => {
  const target = Number(ctx.match[1]);
  const current = db.prepare("SELECT is_banned FROM users WHERE telegram_id = ?").get(target)?.is_banned;
  db.prepare("UPDATE users SET is_banned = ? WHERE telegram_id = ?").run(current ? 0 : 1, target);
  await showAdminUser(ctx, target);
});
bot.action("admin:broadcast:send", async (ctx) => {
  const session = getSession(ctx.chat.id);
  await broadcastToUsers(session.temp_data.broadcastMessage, ctx);
});
bot.action("admin:broadcast:cancel", (ctx) => showAdmin(ctx));

bot.on("photo", processPhoto);
bot.on("text", async (ctx) => {
  const { session, text } = sessionInput(ctx, ctx.message.text);
  if (text.startsWith("/")) return;
  if (session.state === "awaiting_caption") {
    await deleteIncoming(ctx);
    const data = { ...session.temp_data, caption: text };
    saveSession(ctx.chat.id, { temp_data: data });
    await showExpiryStep(ctx);
    return;
  }
  if (session.state === "awaiting_expiry") {
    await deleteIncoming(ctx);
    const expiresAt = parseExpiry(text);
    if (expiresAt === undefined) {
      await sendScreen(ctx.chat.id, "<b>⚠️ Expiry not understood</b>\n\n⌛ Use a duration like <code>12h</code>, <code>30d</code>, or an ISO date.", [[btn("Try Again", "expiry:custom"), btn("Cancel", "menu", "danger")]], ctx);
      return;
    }
    await finishUpload(ctx, { ...session.temp_data, expiresAt });
    return;
  }
  if (session.state === "awaiting_yt_link") {
    await deleteIncoming(ctx);
    if (!/youtube\.com|youtu\.be/i.test(text)) {
      await sendScreen(
        ctx.chat.id,
        "<b>⚠️ এটা সঠিক YouTube লিংক মনে হচ্ছে না</b>\n\n🔗 পুরো YouTube ভিডিও লিংকটা পাঠাও।",
        [[btn("Try Again", "yt:start", "success"), btn("Back to Menu", "menu")]],
        ctx,
      );
      return;
    }
    await sendScreen(ctx.chat.id, "<b>⏬ ভিডিও আনা হচ্ছে…</b>\n\n🔄 একটু অপেক্ষা করো।", [], ctx);
    try {
      await finishYoutubeDownload(ctx, text);
    } catch (error) {
      await sendScreen(
        ctx.chat.id,
        `<b>⚠️ ডাউনলোড করা যায়নি</b>\n\n${escapeHtml(error.message)}`,
        [[btn("Try Again", "yt:start", "success"), btn("Back to Menu", "menu")]],
        ctx,
      );
    }
    return;
  }
  if (session.state === "awaiting_fb_link") {
    await deleteIncoming(ctx);
    if (!/facebook\.com|fb\.watch/i.test(text)) {
      await sendScreen(
        ctx.chat.id,
        "<b>⚠️ এটা সঠিক Facebook লিংক মনে হচ্ছে না</b>\n\n🔗 পুরো Facebook ভিডিও লিংকটা পাঠাও।",
        [[btn("Try Again", "fb:start", "success"), btn("Back to Menu", "menu")]],
        ctx,
      );
      return;
    }
    await sendScreen(ctx.chat.id, "<b>⏬ ভিডিও আনা হচ্ছে…</b>\n\n🔄 একটু অপেক্ষা করো।", [], ctx);
    try {
      await finishFacebookDownload(ctx, text);
    } catch (error) {
      await sendScreen(
        ctx.chat.id,
        `<b>⚠️ ডাউনলোড করা যায়নি</b>\n\n${escapeHtml(error.message)}`,
        [[btn("Try Again", "fb:start", "success"), btn("Back to Menu", "menu")]],
        ctx,
      );
    }
    return;
  }
  if (session.state === "awaiting_tiktok_link") {
    await deleteIncoming(ctx);
    if (!/tiktok\.com/i.test(text)) {
      await sendScreen(
        ctx.chat.id,
        "<b>⚠️ এটা সঠিক TikTok লিংক মনে হচ্ছে না</b>\n\n🔗 পুরো TikTok ভিডিও লিংকটা পাঠাও।",
        [[btn("Try Again", "tiktok:start", "success"), btn("Back to Menu", "menu")]],
        ctx,
      );
      return;
    }
    await sendScreen(ctx.chat.id, "<b>⏬ ভিডিও আনা হচ্ছে…</b>\n\n🔄 একটু অপেক্ষা করো।", [], ctx);
    try {
      await finishTiktokDownload(ctx, text);
    } catch (error) {
      await sendScreen(
        ctx.chat.id,
        `<b>⚠️ ডাউনলোড করা যায়নি</b>\n\n${escapeHtml(error.message)}`,
        [[btn("Try Again", "tiktok:start", "success"), btn("Back to Menu", "menu")]],
        ctx,
      );
    }
    return;
  }
  if (session.state === "awaiting_edit_caption") {
    await deleteIncoming(ctx);
    const link = linkForUser(session.temp_data.linkId, ctx.chat.id);
    if (link) db.prepare("UPDATE links SET caption = ? WHERE id = ?").run(text === "-" ? null : text.slice(0, 200), link.id);
    await showLinkDetail(ctx, session.temp_data.linkId);
    return;
  }
  if (session.state === "awaiting_edit_expiry") {
    await deleteIncoming(ctx);
    const expiresAt = parseExpiry(text);
    if (expiresAt === undefined) {
      await sendScreen(ctx.chat.id, "<b>⚠️ Expiry not understood</b>\n\n⌛ Try <code>12h</code>, <code>30d</code>, or an ISO date.", [[btn("Cancel", `link:${session.temp_data.linkId}`)]], ctx);
      return;
    }
    const link = linkForUser(session.temp_data.linkId, ctx.chat.id);
    if (link) db.prepare("UPDATE links SET expires_at = ? WHERE id = ?").run(expiresAt, link.id);
    await showLinkDetail(ctx, session.temp_data.linkId);
    return;
  }
  if (session.state === "awaiting_default_expiry") {
    await deleteIncoming(ctx);
    const value = text.toLowerCase() === "never" ? "never" : parseExpiry(text);
    if (value === undefined) {
      await sendScreen(ctx.chat.id, "<b>⚠️ Expiry not understood</b>\n\n⌛ Try <code>never</code>, <code>1d</code>, or <code>30d</code>.", [[btn("Cancel", "settings")]], ctx);
      return;
    }
    db.prepare("UPDATE user_settings SET default_expiry = ? WHERE telegram_id = ?").run(text.toLowerCase() === "never" ? "never" : text, ctx.chat.id);
    clearSession(ctx.chat.id);
    await showSettings(ctx);
    return;
  }
  if (session.state === "awaiting_broadcast" && isAdmin(ctx.from.id)) {
    await deleteIncoming(ctx);
    saveSession(ctx.chat.id, { state: "awaiting_broadcast_confirm", temp_data: { broadcastMessage: text } });
    await sendScreen(ctx.chat.id, `<b>👀 Broadcast preview</b>\n\n${escapeHtml(text)}`, [[btn("Send to All", "admin:broadcast:send", "success"), btn("Cancel", "admin:broadcast:cancel", "danger")]], ctx);
    return;
  }
  if (session.state === "awaiting_user_search" && isAdmin(ctx.from.id)) {
    await deleteIncoming(ctx);
    saveSession(ctx.chat.id, { state: "idle", temp_data: { adminUserQuery: text, adminUserPage: 0 } });
    await showAdminUsers(ctx, text, 0);
    return;
  }
  await deleteIncoming(ctx);
  await showMain(ctx);
});

async function expireLinks() {
  const expired = db.prepare("SELECT * FROM links WHERE expires_at IS NOT NULL AND datetime(expires_at) <= CURRENT_TIMESTAMP AND is_deleted = 0").all();
  for (const link of expired) {
    try {
      await deleteRemoteImage(link.image_id);
    } catch {
    }
    db.prepare("UPDATE links SET is_deleted = 1 WHERE id = ?").run(link.id);
    const notify = db.prepare("SELECT notify_expiry FROM user_settings WHERE telegram_id = ?").get(link.owner_telegram_id)?.notify_expiry ?? 1;
    if (notify) {
      await bot.telegram.sendMessage(link.owner_telegram_id, `This link has expired and was removed: ${link.caption || "untitled image"}`).catch(() => {});
    }
  }
}

app.get("/", (_req, res) => res.json({ ok: true, service: "image-url-bot", uptime: Math.floor(process.uptime()) }));
app.get("/health", (_req, res) => res.json({ ok: true, tokenConfigured: Boolean(TOKEN), selfPing: true, uptime: Math.floor(process.uptime()) }));
app.listen(PORT, () => console.log(`ImageLink Bot health server listening on ${PORT}`));

cron.schedule("*/5 * * * *", () => expireLinks().catch((error) => console.error("[expiry]", error.message)));
cron.schedule("*/12 * * * *", async () => {
  try {
    const response = await fetch(`${PUBLIC_URL}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log("[keep-alive] self-ping confirmed", new Date().toISOString());
  } catch (error) {
    console.error("[keep-alive] self-ping failed", error.message);
  }
});

let botStarted = false;

bot.launch().then(() => {
  botStarted = true;
  console.log("ImageLink Bot is running");
  console.log(`[config] TOKEN confirmed | self-ping enabled | health: ${PUBLIC_URL}/health`);
}).catch((error) => {
  console.error("Telegram bot failed to start:", error.message);
  process.exit(1);
});

function shutdown(signal) {
  if (!botStarted) {
    process.exit(0);
    return;
  }
  bot.stop(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
