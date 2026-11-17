'use strict';
// The home server's job: on a booking night, read ClubSpark for the planned slot and hand the
// result back to Railway. It reuses the very same timing as the bot (lib/schedule), so it reads
// from shortly before the courts go out until a few minutes after the release, gently.
//
// It reads ClubSpark the ordinary way, from your home connection, and says honestly what it is.
// It never signs in and never books anything.

const { checkWindows, nextCheckAt } = require('./schedule');
const { iso } = require('./time');

// One pass: for each release whose window is open now, read the sheet if a read is due, and
// pass the result to `onResult`. `cfg` is the plan fetched from Railway. Remembers when it last
// read each night so the reads keep the bot's cadence (every ~2 s just after the release).
function createAgentLoop({ checkCourts, now = Date.now } = {}) {
  const lastReadAt = {};   // night (iso) -> ms of the last read
  return async function tick(cfg, { onResult = () => {} } = {}) {
    if (!cfg || cfg.free === false || !Array.isArray(cfg.order)) return;
    const t = now();
    for (const night of Object.keys(lastReadAt)) if (t - lastReadAt[night] > 3600000) delete lastReadAt[night];
    for (const rel of checkWindows(t, cfg)) {
      const night = iso(rel.night);
      if (lastReadAt[night] && t < nextCheckAt(lastReadAt[night], rel)) continue;
      lastReadAt[night] = t;
      const date = iso(rel.playDate);
      let answer;
      try { answer = await checkCourts(date, rel.start, rel.end); }
      catch (e) { answer = { ok: false, stop: false, why: (e && e.message) || String(e) }; }
      await onResult({ date, start: rel.start, end: rel.end, ...answer });
    }
  };
}

// One line saying what a reading showed, courts in the owner's order. For the home program's log.
function describeReading(order, answer) {
  if (!answer || !answer.ok) return `ClubSpark cannot be read from here: ${(answer && answer.why) || 'no answer'}`;
  if (!answer.visible) return 'ClubSpark answered, but the sheet shows nothing for that day';
  const courts = (Array.isArray(order) ? order : Object.keys(answer.courts)).map(n => `${n} ${answer.courts[n]}`);
  return `ClubSpark can be read from here. Courts: ${courts.join(', ')}`;
}

module.exports = { createAgentLoop, describeReading };
