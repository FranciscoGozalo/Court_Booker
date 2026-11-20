'use strict';
// Glasgow Life Tennis's weekly allowance, as the owner gave it:
//   - at most 7 sessions and 14 hours in a week, across all seven park venues;
//   - a session changed or cancelled still counts towards its week;
//   - courts can be booked up to 7 days ahead (the release rule, kept everywhere else already).
//
// A week is taken to be Monday to Sunday on a UK calendar, by the date the session is played.
// That is an assumption: the rules as given do not say.
//
// What counts in a week:
//   booked   every session the bot has a "booked" result for, at any of the parks (Book now, or
//            your PC's nightly run), cancelled or not: the bot never hears of a cancellation, and
//            a cancelled session still counts. Results are kept 60 days, far longer than a week.
//   planned  what the schedule (Kelvingrove's weekly times and one-off dates) still asks for in
//            that week and has not booked: what your PC will still try.
// Glasgow Club's indoor courts are another organisation's and do not count.
//
// Guards, each refused with a sentence such as "That would be 8 sessions in the week of Mon 23
// Nov; the limit is 7.":
//   Book now                    booked, plus this one, would pass a limit in its week;
//   a one-off date, a weekly    booked plus planned, with the change, would pass a limit in a
//   time (added or changed)     week the change adds to;
//   the nightly run             is not handed a job that would pass a limit, counting what is
//                               booked and the jobs handed out before it; the job gets a result
//                               that says why.

const { iso, label, addDays, civilParts, londonInstant, todayCivil } = require('./time');
const { civilOf, requestsOn, opensAt, LATE_MS } = require('./schedule');

const MAX_SESSIONS = 7;
const MAX_HOURS = 14;

// The Monday of the week a calendar date is in.
const mondayOf = c => addDays(c, -((civilParts(c).dow + 6) % 7));
// The week a session is in: its Monday, as YYYY-MM-DD.
const weekOf = dateIso => iso(mondayOf(civilOf(dateIso)));
const hoursOf = r => Math.max(0, (r.end - r.start) / 60);

// What is booked in a week, from the results: { sessions, hours }.
function bookedIn(results, week) {
  let sessions = 0, hours = 0;
  for (const r of Object.values(results || {})) {
    if (!r || r.status !== 'booked' || typeof r.date !== 'string' || weekOf(r.date) !== week) continue;
    sessions++;
    hours += hoursOf(r);
  }
  return { sessions, hours };
}

// What the schedule still asks for in a week and has not booked: { sessions, hours }. A weekly
// time is still asked for until its release has gone by (with the minutes the PC may still pick it
// up); a one-off date until it starts, since the nightly run tries an open one-off every night.
function plannedIn(cfg, results, week, nowMs) {
  const monday = civilOf(week);
  const onceAt = new Set((cfg.once || []).map(o => `${o.date}@${o.start}`));
  let sessions = 0, hours = 0;
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    for (const r of requestsOn(date, cfg)) {
      const got = results && results[r.id];
      if (got && got.status === 'booked') continue;                          // counted as booked
      if (londonInstant(date, r.start) <= nowMs) continue;                   // started: no longer tried
      if (!onceAt.has(`${r.date}@${r.start}`) && nowMs >= opensAt(date, cfg) + LATE_MS) continue;    // a weekly time whose release has gone by
      sessions++;
      hours += hoursOf(r);
    }
  }
  return { sessions, hours };
}

const amount = h => (Number.isInteger(h) ? String(h) : String(Math.round(h * 10) / 10));
// The sentence for a week that would be over a limit, or null.
function overText(week, sessions, hours) {
  const when = `the week of ${label(civilOf(week))}`;
  if (sessions > MAX_SESSIONS) return `That would be ${sessions} sessions in ${when}; the limit is ${MAX_SESSIONS}.`;
  if (hours > MAX_HOURS) return `That would be ${amount(hours)} hours in ${when}; the limit is ${MAX_HOURS}.`;
  return null;
}

// Book now: would one more session of `hours` on `dateIso` pass a limit? The sentence, or null.
function overIfBooked(results, dateIso, hours) {
  const week = weekOf(dateIso);
  const b = bookedIn(results, week);
  return overText(week, b.sessions + 1, b.hours + hours);
}

// A change to the schedule: `before` and `after` are the schedule without and with it (cfg() in
// app.js, with plan or once changed). Each week from this one to the furthest one-off is looked
// at, and the change is refused for the first week it adds to that would then pass a limit. A
// week already over (say, booked by hand beyond it) does not stop a change that adds nothing there.
function overIfPlanned(before, after, results, nowMs) {
  const first = mondayOf(todayCivil(nowMs));
  let last = addDays(first, 7);
  for (const o of after.once || []) {
    const m = mondayOf(civilOf(o.date));
    if (m > last) last = m;
  }
  for (let m = first; m <= last; m = addDays(m, 7)) {
    const week = iso(m);
    const was = plannedIn(before, results, week, nowMs), will = plannedIn(after, results, week, nowMs);
    if (will.sessions <= was.sessions && will.hours <= was.hours) continue;
    const b = bookedIn(results, week);
    const why = overText(week, b.sessions + will.sessions, b.hours + will.hours);
    if (why) return why;
  }
  return null;
}

// The nightly run: the jobs that fit, in the order given, each counted as booked once handed out;
// and those that do not, each with its sentence.
function fitJobs(jobs, results) {
  const handed = new Map();                       // week -> { sessions, hours } handed out so far
  const keep = [], skip = [];
  for (const j of jobs) {
    const week = weekOf(j.date), b = bookedIn(results, week), h = handed.get(week) || { sessions: 0, hours: 0 };
    const why = overText(week, b.sessions + h.sessions + 1, b.hours + h.hours + hoursOf(j));
    if (why) { skip.push({ job: j, why }); continue; }
    handed.set(week, { sessions: h.sessions + 1, hours: h.hours + hoursOf(j) });
    keep.push(j);
  }
  return { keep, skip };
}

// This week and next, as the app's state shows them (a week ahead always spans two).
function weeks(cfg, results, nowMs) {
  const monday = mondayOf(todayCivil(nowMs));
  return [monday, addDays(monday, 7)].map(m => {
    const week = iso(m), b = bookedIn(results, week), p = plannedIn(cfg, results, week, nowMs);
    return { week, sessions: b.sessions, hours: b.hours, plannedSessions: p.sessions, plannedHours: p.hours, maxSessions: MAX_SESSIONS, maxHours: MAX_HOURS };
  });
}

module.exports = { MAX_SESSIONS, MAX_HOURS, mondayOf, weekOf, bookedIn, plannedIn, overText, overIfBooked, overIfPlanned, fitJobs, weeks };
