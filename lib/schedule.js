'use strict';
// Which nights matter and when each message is due.

const { todayCivil, addDays, londonInstant, dayKey, iso } = require('./time');
const { slotEnd } = require('./plan');

const LINKS_LATE_MS = 3 * 60 * 1000;   // after a restart, the links (and turning them to GO) are still worth doing this long after the release
const WARN_LATE_MS = 2 * 60 * 1000;    // a heads-up more than two minutes late is just noise
const CHECK_EARLY_MS = 15 * 1000;      // start reading the booking sheet this long before the courts go out
const CHECK_AFTER_MS = 5 * 60 * 1000;  // and keep reading it this long after the release

// The release that happens on `night`, if the day it opens is in the plan.
function releaseFor(night, cfg) {
  const playDate = addDays(night, cfg.daysAhead);
  const entry = cfg.plan[dayKey(playDate)];
  if (!entry) return null;
  return {
    night, playDate,
    releaseAt: londonInstant(night, cfg.releaseMin),
    start: entry.start, end: slotEnd(entry.start, entry.hours), hours: entry.hours,
  };
}

// The timed messages for one release: a heads-up, the links, then GO.
function eventsFor(rel, cfg) {
  const linksAt = rel.releaseAt - cfg.lead * 1000;
  const events = [];
  if (cfg.warnMin > 0) {
    const at = rel.releaseAt - cfg.warnMin * 60000;
    events.push({ type: 'warn', at, until: Math.min(at + WARN_LATE_MS, linksAt - 5000) });   // never right on top of the links
  }
  events.push({ type: 'links', at: linksAt, until: rel.releaseAt + LINKS_LATE_MS });
  if (cfg.go) events.push({ type: 'go', at: rel.releaseAt, until: rel.releaseAt + LINKS_LATE_MS });
  return events.filter(e => e.until > e.at).map(e => ({ ...e, key: `${iso(rel.night)}:${e.type}`, rel }));
}

// Messages whose moment has come, have not been sent, and are not too late to be useful.
function dueEvents(nowMs, cfg, sent) {
  const today = todayCivil(nowMs);
  const out = [];
  for (const night of [addDays(today, -1), today]) {   // yesterday too, for a release set just before midnight
    const rel = releaseFor(night, cfg);
    if (!rel) continue;
    for (const e of eventsFor(rel, cfg)) {
      if (nowMs >= e.at && nowMs < e.until && !(sent && sent[e.key])) out.push(e);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Milliseconds until the next timed message, or null if none is coming in the next day.
function msToNextEvent(nowMs, cfg) {
  const today = todayCivil(nowMs);
  let best = null;
  for (const night of [addDays(today, -1), today]) {
    const rel = releaseFor(night, cfg);
    if (!rel) continue;
    for (const e of eventsFor(rel, cfg)) {
      if (e.at > nowMs && (best === null || e.at - nowMs < best)) best = e.at - nowMs;
    }
  }
  return best;
}

// The releases (tonight's, or last night's just after midnight) whose booking sheet is worth reading now.
function checkWindows(nowMs, cfg) {
  const today = todayCivil(nowMs);
  const out = [];
  for (const night of [addDays(today, -1), today]) {
    const rel = releaseFor(night, cfg);
    if (!rel) continue;
    const from = rel.releaseAt - cfg.lead * 1000 - CHECK_EARLY_MS, until = rel.releaseAt + CHECK_AFTER_MS;
    if (nowMs >= from && nowMs < until) out.push(rel);
  }
  return out;
}

// When to read the sheet next, after reading it at `nowMs`. Before the release nothing changes,
// so once every 10 s, with one read just after the release. Then often while courts are going,
// and less often after that.
function nextCheckAt(nowMs, rel) {
  if (nowMs < rel.releaseAt) return Math.min(nowMs + 10000, rel.releaseAt + 500);
  const since = nowMs - rel.releaseAt;
  return nowMs + (since < 30000 ? 2000 : since < 120000 ? 5000 : 15000);
}

// The next release still to come, looking two weeks ahead.
function nextRelease(nowMs, cfg) {
  const today = todayCivil(nowMs);
  for (let i = 0; i < 15; i++) {
    const rel = releaseFor(addDays(today, i), cfg);
    if (rel && rel.releaseAt > nowMs) return rel;
  }
  return null;
}

// A day that is already open, for trying the links out: the same weekday this week while
// that time is still ahead, otherwise tomorrow.
function checkDate(nowMs, cfg, rel) {
  const today = todayCivil(nowMs);
  const same = addDays(rel.playDate, -cfg.daysAhead);
  if (same >= today && nowMs < londonInstant(same, rel.start) - 5 * 60000) return same;
  return addDays(today, 1);
}

module.exports = { LINKS_LATE_MS, WARN_LATE_MS, CHECK_EARLY_MS, CHECK_AFTER_MS, checkWindows, nextCheckAt, releaseFor, eventsFor, dueEvents, msToNextEvent, nextRelease, checkDate };
