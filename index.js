'use strict';
// Court alert: a Telegram bot that sends you the Kelvingrove court links just before a new
// day is released, and turns the message to GO at the release. It reads the public booking
// sheet to lead with the first free court in your order. You do the booking.
// Needs Node 20 or later and one variable, TELEGRAM_BOT_TOKEN. See README.md.

const { createApp, VERSION } = require('./app');
const { createTelegram } = require('./lib/telegram');
const { createStore } = require('./lib/store');
const { createCourtChecker } = require('./lib/availability');
const { clockAt, londonWall } = require('./lib/time');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const COMMANDS = [
  ['plan', 'Your plan and the next alert'],
  ['set', 'Add a day: /set thu 19:00 2h'],
  ['off', 'Remove a day: /off thu'],
  ['order', 'Court order: /order 4 3 5 2 6 1'],
  ['test', 'Send the courts now for an open day'],
  ['free', 'Which courts are free now'],
  ['signin', 'Open the booking sheet to sign in'],
  ['style', 'Card, buttons, links or both'],
  ['status', 'Clock, version and settings'],
  ['pause', 'Stop alerts'],
  ['resume', 'Start alerts again'],
  ['help', 'Everything I understand'],
];

// The whole bot depends on knowing UK time, so check this server can work it out.
function ukTimeWorks() {
  try {
    return londonWall(Date.UTC(2026, 6, 1, 12, 0, 0)).hh === 13    // summer: one hour ahead of UTC
      && londonWall(Date.UTC(2026, 0, 1, 12, 0, 0)).hh === 12;     // winter: the same as UTC
  } catch { return false; }
}

async function main() {
  log(`Court alert starting, version ${VERSION}, Node ${process.version}.`);
  if (!ukTimeWorks()) {
    log('This server cannot work out UK time (no time zone data in this Node build). Use the Dockerfile in this repository.');
    await sleep(60000);
    process.exit(1);
  }
  log(`UK time is ${clockAt(Date.now())}.`);

  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) {
    log('TELEGRAM_BOT_TOKEN is missing. Get a token from @BotFather in Telegram and add it under Variables in Railway.');
    await sleep(60000);   // slow the restart loop so the log stays readable
    process.exit(1);
  }

  const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
  const store = createStore(dataDir, { log });
  const tg = createTelegram(token, { apiUrl: process.env.TELEGRAM_API_URL || undefined });
  const app = createApp({ tg, store, log, env: process.env, checkCourts: createCourtChecker() });
  log(`Settings file: ${store.file}`);
  if (!app.hasPictures) log('The banner pictures are missing (assets/banner-wait.jpg and banner-open.jpg), so the card look will come as plain text.');

  try {
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
  if (app.kept() === 'no') log('Settings are NOT kept across restarts. Add a Railway volume mounted at /data, or send the bot /backup.');
  await app.announce();

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

  // Read messages from Telegram as they arrive (long polling).
  let offset = 0, pause = 1000;
  while (!stopping) {
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

main().catch(e => { log(`Fatal: ${e.stack || e.message}`); process.exit(1); });
