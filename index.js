'use strict';
// Court booker: the bot behind the iPhone app (and, if you like, a Telegram bot) that keeps your
// booking requests. At each release
// your PC at home signs in to ClubSpark and books (Cloudflare turns Railway away), reports
// back here, and the bot sends you the court, the time and the gate code on a banner card.
// For Glasgow Club's indoor courts (Gorbals, Scotstoun) it shows what is free, has your PC put
// one in your basket when you tap Hold, and leaves the paying to you; from the app (2.11.3) your PC
// books one there now and pays for it, as it books a park now.
// Needs Node 20 or later, and AGENT_PUBLIC_KEY (or AGENT_TOKEN) for your PC. Telegram is optional
// (2.13): without TELEGRAM_BOT_TOKEN the bot says nothing there, and the app is the way in. See README.md.

const { createApp, VERSION } = require('./app');
const { createTelegram, createQuietTelegram } = require('./lib/telegram');
const { createStore } = require('./lib/store');
const { createServer, readPublicKey } = require('./lib/server');
const { clockAt, londonWall } = require('./lib/time');
const { fromEnv } = require('./lib/apns');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const COMMANDS = [
  ['menu', 'Buttons for everything'],
  ['plan', 'What is booked when'],
  ['book', 'One date: /book 25 nov 19:00 2h'],
  ['gorbals', 'Indoor courts free at Gorbals'],
  ['scotstoun', 'Indoor courts free at Scotstoun'],
  ['set', 'Every week: /set thu 19:00 2h'],
  ['cancel', 'Remove a one-off: /cancel 2'],
  ['off', 'Stop a weekday: /off thu'],
  ['order', 'Court order: /order 3 4 5 2 1 6'],
  ['status', 'Clock, your PC and settings'],
  ['wake', 'Wake your PC from sleep'],
  ['sleep', 'Put your PC to sleep'],
  ['app', 'Link the iPhone app'],
  ['pause', 'Stop booking'],
  ['resume', 'Start booking again'],
  ['help', 'Everything I understand'],
];

// The endpoint your PC and the iPhone app talk to, with every handler the bot has. The tests build
// it with this very function (test/glasgowbook.test.js), so a handler left out here shows there: a
// route without its handler answers as an older bot would, never with a go-ahead. `extra`: the
// server's other options (tests shorten its waits).
function serverFor(app, { token = '', publicKey = null, log = () => {}, ...extra } = {}) {
  const appApi = { hello: app.appHello, pair: app.appPair, auth: app.appAuth, state: app.appState, ask: app.appAsk, widget: app.appWidget };
  return createServer({ getJobs: app.jobsForAgent, onResult: app.resultFromAgent, onPing: app.pingFromAgent, onLook: app.lookFromAgent, onHold: app.holdFromAgent, onProgress: app.progressFromAgent, picture: app.picture, token, publicKey, log, appApi,
    onClubSpark: app.clubSparkFromAgent, onGlasgowBook: app.glasgowBookFromAgent, onPair: app.pairFromAgent, ...extra });
}

// The whole bot depends on knowing UK time, so check this server can work it out.
function ukTimeWorks() {
  try {
    return londonWall(Date.UTC(2026, 6, 1, 12, 0, 0)).hh === 13    // summer: one hour ahead of UTC
      && londonWall(Date.UTC(2026, 0, 1, 12, 0, 0)).hh === 12;     // winter: the same as UTC
  } catch { return false; }
}

async function main() {
  log(`Court booker starting, version ${VERSION}, Node ${process.version}.`);
  if (!ukTimeWorks()) {
    log('This server cannot work out UK time (no time zone data in this Node build). Use the Dockerfile in this repository.');
    await sleep(60000);
    process.exit(1);
  }
  log(`UK time is ${clockAt(Date.now())}.`);

  // Telegram is optional (2.13). Without its token the bot says nothing there and reads nothing from it:
  // the app is the way in, its notes and notifications say what Telegram would have.
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) log('TELEGRAM_BOT_TOKEN is not set, so Telegram is off: the iPhone app is the way in.');

  const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
  const store = createStore(dataDir, { log });
  const tg = token ? createTelegram(token, { apiUrl: process.env.TELEGRAM_API_URL || undefined }) : createQuietTelegram();

  // Your PC reaches the bot over HTTP and proves who it is by signing with its own key
  // (AGENT_PUBLIC_KEY holds the public half) or with a shared AGENT_TOKEN. With neither, the
  // bot still keeps your requests, but nothing can collect them.
  const agentToken = (process.env.AGENT_TOKEN || '').trim();
  let publicKey = null;
  try { publicKey = readPublicKey(process.env.AGENT_PUBLIC_KEY); } catch (e) { log(`AGENT_PUBLIC_KEY could not be read: ${e.message}`); }
  const linked = !!(agentToken || publicKey);
  // Today's court on the iPhone's Lock Screen, started by a push with the app closed (2.14): Apple's own
  // push service, with the key from APNS_KEY and its ids. Without them it is off, and the log says so once.
  const apns = fromEnv(process.env, { log });
  const app = createApp({ tg, store, log, env: process.env, linked, apns });
  log(`Settings file: ${store.file}`);
  if (!app.hasPictures) log('Some banner pictures are missing from assets/ (see art/make-banners.cjs), so cards will come as plain text.');

  // The endpoint your PC talks to. Also answers a plain /health, which lets Railway give the
  // service a public domain. The iPhone app comes in by the same server, under /app/, with its
  // own tokens (docs/app-api.md), so it is there only where this is.
  if (!linked && !token) {
    // Neither Telegram nor the app (which comes in by your PC's door) could reach a bot like this.
    log('Telegram is off and your PC is not linked, so nothing can reach this bot. Add AGENT_PUBLIC_KEY (or AGENT_TOKEN) under Variables in Railway.');
  }
  if (linked) {
    const server = serverFor(app, { token: agentToken, publicKey, log });
    const port = Number(process.env.PORT) || 8080;
    server.listen(port, () => log(`Listening for your PC on port ${port} (${[publicKey && 'signed requests', agentToken && 'AGENT_TOKEN'].filter(Boolean).join(' or ')}).`));
    server.on('error', e => log(`The endpoint for your PC could not start: ${e.message}`));
  } else {
    log('Neither AGENT_PUBLIC_KEY nor AGENT_TOKEN is set, so your PC cannot collect bookings. Add one under Variables in Railway.');
  }

  if (token) try {
    const me = await tg.call('getMe');
    log(`Signed in to Telegram as @${me.username}`);
    await tg.call('deleteWebhook', { drop_pending_updates: false });
    await tg.call('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
  } catch (e) {
    log(`Telegram start-up call failed: ${e.message}`);
    if (e.code === 401 || e.code === 404) {
      log('Telegram rejected the token. Check TELEGRAM_BOT_TOKEN under Variables in Railway.');
      await sleep(60000);
      process.exit(1);
    }
  }
  if (app.kept() === 'no') log(`Settings are NOT kept across restarts. Add a Railway volume mounted at /data${token ? ', or send the bot /backup' : ''}.`);
  await app.announce();
  // Can this server read Glasgow Club's free indoor courts? One look, said in the log; the
  // rest of the start-up does not wait for it.
  app.checkIndoor().catch(e => log(`The look at Glasgow Club failed: ${e.message}`));

  // Timed messages: look every 100 ms, and wake exactly on time when one is nearly due.
  let stopping = false, timer = null;
  const beat = () => {
    if (stopping) return;
    app.tick().catch(e => log(`Tick failed: ${e.message}`)).finally(() => {
      if (stopping) return;
      let next = 100;
      try { const ms = app.msToNext(); if (ms !== null) next = Math.max(2, Math.min(100, ms)); } catch (e) { log(`Timer failed: ${e.message}`); }
      timer = setTimeout(beat, next);
    });
  };
  beat();

  const stop = () => { stopping = true; clearTimeout(timer); log('Stopping'); setTimeout(() => process.exit(0), 200); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('unhandledRejection', e => log('Unhandled error:', e && e.message ? e.message : e));

  // Read messages from Telegram as they arrive (long polling). With Telegram off there is nothing to read:
  // the server and the timers keep the bot going.
  let offset = 0, pause = 1000;
  while (token && !stopping) {
    try {
      const updates = await tg.getUpdates(offset, 50);
      pause = 1000;
      for (const u of updates) {
        offset = u.update_id + 1;
        await app.handleUpdate(u).catch(e => log(`Could not handle a message: ${e.message}`));
      }
    } catch (e) {
      if (stopping) break;
      if (e.code === 409) log('Another copy of this bot is reading messages (normal for a few seconds during a redeploy).');
      else if (e.name !== 'TimeoutError') log(`Reading messages failed: ${e.message}`);
      await sleep(e.code === 409 ? 5000 : pause);
      pause = Math.min(pause * 2, 30000);
    }
  }
}

// Started as the bot (node index.js, as the Dockerfile does); a test that only wants serverFor
// requires this file without starting anything.
if (require.main === module) main().catch(e => { log(`Fatal: ${e.stack || e.message}`); process.exit(1); });

module.exports = { serverFor };
