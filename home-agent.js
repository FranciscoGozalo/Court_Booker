'use strict';
// Run this on your home server when Railway is set to "home checks". It reads ClubSpark for your
// planned slot from your home connection (which ClubSpark lets in) and posts what it finds to the
// Railway bot, which sends you the card. It talks only to ClubSpark and to your Railway bot.
//
// It needs Node 20+ and no packages. Two variables:
//   RELAY_URL     your Railway bot's web address, for example https://court-booker.up.railway.app
//   AGENT_TOKEN   the same long random token you set on the Railway bot
// See the "Run the check from your home server" section of README.md.

const { createCourtChecker } = require('./lib/availability');
const { createAgentLoop, describeReading } = require('./lib/agent');
const { nextRelease, checkDate } = require('./lib/schedule');
const { clockAt, londonWall, iso, label } = require('./lib/time');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ukTimeWorks() {
  try {
    return londonWall(Date.UTC(2026, 6, 1, 12, 0, 0)).hh === 13 && londonWall(Date.UTC(2026, 0, 1, 12, 0, 0)).hh === 12;
  } catch { return false; }
}

async function main() {
  const base = (process.env.RELAY_URL || '').trim().replace(/\/+$/, '');
  const token = (process.env.AGENT_TOKEN || '').trim();
  log(`Court alert home agent starting, Node ${process.version}.`);
  if (!base || !token) {
    log('RELAY_URL and AGENT_TOKEN are both needed. RELAY_URL is your Railway bot\'s web address; AGENT_TOKEN is the token you set on it.');
    process.exit(1);
  }
  if (!ukTimeWorks()) { log('This machine cannot work out UK time. Install up-to-date time-zone data for Node.'); process.exit(1); }
  log(`UK time is ${clockAt(Date.now())}. Relay: ${base}`);

  const auth = { authorization: `Bearer ${token}` };
  const api = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) }, signal: AbortSignal.timeout(10000) });

  // Check the relay is reachable and the token is right, before the first booking night relies on it.
  try {
    const r = await api('/agent/plan');
    if (r.status === 401) { log('The Railway bot did not accept the token. Make AGENT_TOKEN the same on both ends.'); process.exit(1); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    log('Reached the Railway bot and the token works.');
  } catch (e) {
    log(`Could not reach the Railway bot at ${base}: ${e.message}. Check RELAY_URL and that the bot has a public domain. Carrying on; it may come up.`);
  }

  const checkCourts = createCourtChecker();
  const loop = createAgentLoop({ checkCourts });

  // Keep a copy of the plan, refreshed from Railway every minute, so a change you make in Telegram
  // reaches the home server without a restart.
  let cfg = null, lastPlanAt = 0;
  async function refreshPlan() {
    try {
      const r = await api('/agent/plan');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (body && body.ok && body.plan) { cfg = body.plan; lastPlanAt = Date.now(); }
    } catch (e) { log(`Could not fetch the plan: ${e.message}`); }
  }
  async function post(result) {
    try {
      const r = await api('/agent/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) });
      if (!r.ok) log(`The bot would not take a reading: HTTP ${r.status}`);
      else if (result.ok) log(`Read ${result.date} ${hhmm(result.start)}: ${freeCount(result.courts)} free. Sent.`);
      else log(`Read ${result.date}: ${result.why}. Sent.`);
    } catch (e) { log(`Could not send a reading: ${e.message}`); }
  }

  let stopping = false;
  const stop = () => { stopping = true; log('Stopping'); setTimeout(() => process.exit(0), 100); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.on('unhandledRejection', e => log('Unhandled error:', e && e.message ? e.message : e));

  await refreshPlan();

  // One read now, for a day that is already open, so it is plain from the start whether ClubSpark
  // lets this machine in. On booking nights the reads follow the release by themselves.
  const rel = cfg && cfg.free !== false ? nextRelease(Date.now(), cfg) : null;
  if (rel) {
    const date = checkDate(Date.now(), cfg, rel);
    const answer = await checkCourts(iso(date), rel.start, rel.end);
    log(`Test read, ${label(date)} ${hhmm(rel.start)}–${hhmm(rel.end)}: ${describeReading(cfg.order, answer)}`);
    log(`Next booking night: ${label(rel.night)}, for ${label(rel.playDate)}. Leave this running.`);
  } else if (cfg) {
    log(cfg.free === false ? 'The free-court check is switched off in the bot (/free on to use it).' : 'No day is set in the bot yet (/set thu 19:00 2h).');
  }

  while (!stopping) {
    if (Date.now() - lastPlanAt > 60000) await refreshPlan();
    try { await loop(cfg, { onResult: post }); } catch (e) { log(`Tick failed: ${e.message}`); }
    await sleep(1000);
  }
}

const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const freeCount = courts => Object.values(courts || {}).filter(s => s === 'free').length;

main().catch(e => { log(`Fatal: ${e.stack || e.message}`); process.exit(1); });
