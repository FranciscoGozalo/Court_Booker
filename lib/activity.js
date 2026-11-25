'use strict';
// Today's court on the iPhone's Lock Screen and in its Dynamic Island (a Live Activity, 2.14), started
// by a push from here (lib/apns.js) while the app is closed.
//
// Which court, and the words on it, are worked out exactly as the app works them out for the one it
// starts itself (the app's src/data/view.js: courtActivity, courtPill, courtPlace and courtsName), from
// the same `results` the app is shown: so a card started by a push says, to the character, what a card
// the app started would. Change one, change the other.
//
// The court: the first booked court that is not over yet, soonest first, once it starts within eight
// hours (a Live Activity lasts eight hours). Its props, the card's words: { place, day, time, start,
// court, pillLabel, pillValue, startsAt, endsAt }. The card counts down to the start by itself, and goes
// stale at the end: nothing on it ever needs changing.

const { iso, label, hhmm, londonInstant, todayCivil } = require('./time');
const { civilOf } = require('./schedule');

const LEAD_MS = 8 * 3600000;                // one is started for a court starting within this
const NAME = 'CourtActivity';               // the app's Live Activity (createLiveActivity('CourtActivity', …))
const ATTRIBUTES_TYPE = 'LiveActivityAttributes';     // its ActivityKit attributes, as expo-widgets names them

// ---------- the app's own words (view.js), ported ----------
const at = (date, minutes) => londonInstant(civilOf(date), minutes);
const slotText = (start, end) => `${hhmm(start)}–${hhmm(end)}`;          // "16:00–18:00", an en dash
const byWhen = (a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1);
// Whether a booked court has been played: its day has gone (`past`), or it has ended.
const played = (r, now) => !!r.past || at(r.date, r.end) <= now;
// Courts booked and not played yet, soonest first.
const courtsAhead = (state, now) => (state.results || []).filter(r => r.status === 'booked' && !played(r, now)).sort(byWhen);
// "3 & 4" (and "1, 2 & 3", were there ever three).
const andList = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}` : String(list[0] ?? ''));
// A court by name: "Court 3", or "Courts 3 & 4" for two at once.
function courtsName(x) {
  if (!x) return 'Court';
  if (Array.isArray(x.courts) && x.courts.length > 1) return `Courts ${andList(x.courts)}`;
  if (x.courtName) return x.courtName;
  const one = String((Array.isArray(x.courts) && x.courts.length ? x.courts[0] : x.court) ?? '');
  return /[&,]/.test(one) ? `Courts ${one}` : `Court ${one}`;
}
// The pill: the gate code at a park, what was paid at Glasgow Club (only once paid), or null.
function courtPill(r) {
  if (r.gate) return { label: 'Gate', value: String(r.gate) };
  if (r.paid === true && r.price) return { label: 'Paid', value: r.price };
  return null;
}
// The place, short, as the app's venue chips name it: "Kelvingrove", "Queens Park", "Gorbals".
const SHORT = { drumchapel: 'Drumchapel', garrowhill: 'Garrowhill', kelvingrove: 'Kelvingrove', knightswood: 'Knightswood', maryhill: 'Maryhill' };
const PAID = { gorbals: 'Gorbals', scotstoun: 'Scotstoun' };             // the app's own names for the venues your PC pays at
const venueKeyOf = r => (r && r.venue) || 'kelvingrove';
function courtPlace(state, r) {
  const key = venueKeyOf(r);
  const venues = Array.isArray(state.venues) && state.venues.length ? state.venues
    : [{ key: 'kelvingrove', name: 'Kelvingrove' }, { key: 'gorbals', name: 'Gorbals' }, { key: 'scotstoun', name: 'Scotstoun' }];      // a bot before 2.9 (never this one)
  const v = venues.find(x => x.key === key);
  if (v) return SHORT[key] || PAID[key] || v.name;
  return key === 'kelvingrove' ? state.venue.name : key;
}
// A court's page in the app, which a tap on the card opens.
const urlOf = r => `courtbooker:///ticket?id=${encodeURIComponent(r.id)}`;

// The card for one booked court, whenever it is: { key, startsAt, endsAt, url, props }.
function activityOf(state, r) {
  const startsAt = at(r.date, r.start), endsAt = at(r.date, r.end);
  const pill = courtPill(r);
  return {
    key: r.id, startsAt, endsAt, url: urlOf(r),
    props: { place: courtPlace(state, r), day: label(civilOf(r.date)), time: slotText(r.start, r.end), start: hhmm(r.start), court: courtsName(r), pillLabel: pill ? pill.label.toUpperCase() : '', pillValue: pill ? pill.value : '', startsAt, endsAt },
  };
}
// The court on the Lock Screen at `now`, or null: the next court not over yet, once it starts within
// eight hours. `state` is the state as the app is shown it (its `results` and `venues`).
function courtActivity(state, now) {
  const r = courtsAhead(state, now)[0] || null;
  if (!r) return null;
  const a = activityOf(state, r);
  return a.startsAt - now > LEAD_MS ? null : a;
}

// ---------- what Apple is sent ----------
const seconds = ms => Math.floor(ms / 1000);
// The card's content as ActivityKit reads it (expo-widgets' ContentState): the activity's name, and its
// props as one JSON string, as the app's own start() sends them. `props` null: none (it is ending).
const contentState = props => (props === null ? { name: NAME } : { name: NAME, props });
// Starts the card on a phone, with the app closed (a push-to-start). With a notification, as Apple asks
// of one started this way: "Court 3 today", "Kelvingrove · 16:00–18:00" ("… tomorrow" for a court
// early in the morning, started before midnight). It goes stale at the end.
function startPayload(a, now) {
  const today = iso(todayCivil(a.startsAt)) === iso(todayCivil(now));
  return { aps: {
    timestamp: seconds(now), event: 'start', 'content-state': contentState(JSON.stringify(a.props)),
    'attributes-type': ATTRIBUTES_TYPE, attributes: { url: a.url }, 'stale-date': seconds(a.endsAt),
    alert: { title: `${a.props.court} ${today ? 'today' : 'tomorrow'}`, body: `${a.props.place} · ${a.props.time}` },
  } };
}
// Ends a card at once (its court is over, or another took its place): `props` the words it showed, as
// one JSON string, or null when they are not known any more.
function endPayload(props, now) {
  return { aps: { timestamp: seconds(now), event: 'end', 'dismissal-date': seconds(now), 'content-state': contentState(props) } };
}

module.exports = {
  LEAD_MS, NAME, ATTRIBUTES_TYPE,
  played, courtsAhead, courtsName, courtPill, courtPlace, activityOf, courtActivity, startPayload, endPayload,
};
