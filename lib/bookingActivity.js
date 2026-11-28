'use strict';
// The booking itself on the Lock Screen (2.16; Francisco, 28 Nov 2026: "I would like them to track the
// booking process, starting 1 hour before the booking taking place… specifically relevant for bookings
// that take place at the start time like 22 or 00"). A Live Activity from an hour before a release that
// books something for you (the parks at 22:00, Glasgow Club at 00:00) until the result: started by a
// push, kept up to date by Apple's broadcast pushes on a channel of its own (so the app can stay
// closed), ended a quarter of an hour after the result. The app draws it (its BookingActivity.ios.js);
// every word on it is worked out here, from what the bot knows: the time, your PC's run (started, signed
// in, trying again), your bank asking at Glasgow Club, and the results. The countdowns run on the iPhone.
//
// Book now (a time open already) gets none: only a release's own bookings.

const { label, hhmm, clockAt } = require('./time');
const { civilOf } = require('./schedule');
const V = require('./venues');
const { courtsName } = require('./activity');

const LEAD_MS = 60 * 60 * 1000;            // shown from this long before the release
const BANK_WAIT_MS = 5 * 60 * 1000;        // your PC waits this long for your bank's approval
const FRESH_MS = 15 * 60 * 1000;           // a result counts for a release from this long before it (a booking at any time)
const NAME = 'BookingActivity';

const slot = r => `${hhmm(r.start)}–${hhmm(r.end)}`;
const placeOf = r => V.placeName(r.venue || V.SCHEDULED, r.type);
const shortPlace = r => {
  const name = placeOf(r);
  return name.replace(/ Park$/, '').replace(/^Kelvingrove.*/, 'Kelvingrove');
};
const courtsAsked = r => (Number.isInteger(r.courts) && r.courts > 1 ? r.courts : 1);

// This release's result for a request, or null: booked at any time, or anything said since shortly before it.
function resultFor(rel, r, results) {
  const got = results && results[r.id];
  if (!got) return null;
  return got.status === 'booked' || (Number(got.at) || 0) >= rel.releaseAt - FRESH_MS ? got : null;
}
// The reason, short, for the large words: "No court free", else "Not booked".
const shortWhy = got => (got.status === 'none' ? 'No court free' : 'Not booked');

/**
 * The card's words at `now`: { stage, final, props }. `rel`: the release ({ releaseAt, requests, club }).
 * `pcRunAt`: when your PC's run for it starts (21:55, 23:50). `order`: the parks' court order. `results`:
 * the bot's results. `run`: { lastRun, note: { stage, at, why } } (the run started, signed in, trouble).
 * `bank`: { at, price } when your bank asked to approve a payment for one of its bookings, else null.
 * `late`: how long after the release a result may still come (10 minutes at the parks, 30 at Glasgow Club).
 */
function cardFor({ rel, now, pcRunAt, order = [], results = {}, run = {}, bank = null, late = 10 * 60000 }) {
  const reqs = rel.requests;
  const first = reqs[0];
  const opens = clockAt(rel.releaseAt).slice(0, 5);
  const more = reqs.length > 1 ? ` +${reqs.length - 1}` : '';
  const base = { place: `${shortPlace(first)}${more}`, meta: `${label(civilOf(first.date))} · ${slot(first)}`, icon: '', big: '', from: 0, to: 0, bar: false, pillKey: '', pillValue: '', note: '', short: '' };
  const done = reqs.map(r => resultFor(rel, r, results));
  const started = Number(run.lastRun) >= pcRunAt - 5 * 60000;
  const note = run.note && Number(run.note.at) >= pcRunAt - 5 * 60000 ? run.note : null;
  const courtsPill = rel.club
    ? { pillKey: 'COURTS', pillValue: String(reqs.reduce((n, r) => n + courtsAsked(r), 0)) }
    : order.length ? { pillKey: 'COURTS', pillValue: order.slice(0, 3).join(', ') } : {};
  const said = (stage, final, props) => ({ stage, final, props: { ...base, ...props } });

  // Every booking has its result: booked (the first booked), or not.
  if (done.every(Boolean)) {
    const i = done.findIndex(g => g.status === 'booked');
    const others = reqs.map((r, k) => (k === (i >= 0 ? i : 0) ? null : `${slot(r)} ${done[k].status === 'booked' ? `booked, ${courtsName(done[k])}` : 'not booked'}`)).filter(Boolean);
    const also = others.length ? `Also: ${others.join('; ')}.` : '';
    if (i >= 0) {
      const g = done[i];
      const pill = g.gate ? { pillKey: 'GATE', pillValue: String(g.gate) } : g.paid === true && g.price ? { pillKey: 'PAID', pillValue: g.price } : {};
      return said('booked', true, { meta: `${label(civilOf(reqs[i].date))} · ${slot(reqs[i])}`, label: 'BOOKED', tone: 'blue', icon: 'checkmark', big: courtsName(g), ...pill, note: also, short: pill.pillValue || 'Booked' });
    }
    const g = done[0];
    const why = String(g.why || '').replace(/\s+/g, ' ').trim();
    return said('none', true, { label: 'NOT BOOKED', tone: 'red', icon: 'xmark', big: shortWhy(g),
      note: [why && why.length <= 90 ? (/[.!?]$/.test(why) ? why : `${why}.`) : '', also, 'Tap to try another time.'].filter(Boolean).join(' '), short: 'Not booked' });
  }
  // Past the time a result could still come: no word from your PC.
  if (now >= rel.releaseAt + late) {
    return said('silent', true, { label: 'NO WORD FROM YOUR PC', tone: 'amber', icon: 'exclamationmark.triangle', big: 'No result', note: rel.club ? 'Look under Bookings on Glasgow Club’s site, and in your banking app.' : 'Look at your bookings on ClubSpark.', short: 'No word' });
  }
  // Your bank asked to approve a payment: five minutes, counting.
  if (bank && now < bank.at + BANK_WAIT_MS) {
    return said('approve', false, { label: 'APPROVE IN YOUR BANK’S APP', tone: 'amber', icon: 'building.columns', from: bank.at, to: bank.at + BANK_WAIT_MS, bar: true,
      ...(bank.price ? { pillKey: 'TOTAL', pillValue: bank.price } : {}), note: 'Your PC waits five minutes for it.' });
  }
  // The release has come: booking.
  if (now >= rel.releaseAt) {
    if (!started) {
      return said('nostart', false, { label: 'YOUR PC HASN’T STARTED', tone: 'amber', icon: 'exclamationmark.triangle', big: 'Not started', note: 'Wake it from the app; it books as soon as it starts.', short: 'Not started' });
    }
    return said('booking', false, { label: rel.club ? 'BOOKING AND PAYING' : 'BOOKING', tone: 'blue', icon: 'hourglass', big: rel.club ? 'Booking…' : order.length ? `Court ${order[0]}…` : 'Booking…', ...courtsPill,
      note: !rel.club && order.length > 1 ? `Court ${order[0]} first, then ${order.slice(1, 3).join(', then ')}.` : rel.club ? 'With the card kept on your PC.' : '', short: 'Booking' });
  }
  // Before it: counting down to the release, with what your PC is doing.
  const count = { from: rel.releaseAt - LEAD_MS, to: rel.releaseAt, bar: true, ...courtsPill };
  if (started && note && note.stage === 'trouble') {
    return said('trouble', false, { ...count, label: 'TRYING AGAIN', tone: 'amber', icon: 'arrow.clockwise', note: 'An attempt didn’t work; your PC is trying again.' });
  }
  if (started && note && note.stage === 'ready') {
    return said('ready', false, { ...count, label: 'SIGNED IN · READY', tone: 'green', icon: 'checkmark', note: `Waiting for ${opens}.${!rel.club && order.length ? ' It tries the courts in your order.' : ''}` });
  }
  if (started) {
    return said('awake', false, { ...count, label: `OPENS AT ${opens}`, tone: 'blue', note: `Your PC is awake and signing in to ${rel.club ? 'Glasgow Club' : 'ClubSpark'}.` });
  }
  if (now >= pcRunAt + 2 * 60000) {
    return said('asleep', false, { ...count, label: 'YOUR PC ISN’T ANSWERING', tone: 'amber', icon: 'exclamationmark.triangle', note: 'Wake it from the app before the booking opens.' });
  }
  return said('waiting', false, { ...count, label: `OPENS AT ${opens}`, tone: 'blue', note: `Your PC wakes at ${clockAt(pcRunAt).slice(0, 5)}${rel.club ? ' and pays with the card kept on it' : ''}.` });
}

// ---------- what Apple is sent ----------
const seconds = ms => Math.floor(ms / 1000);
// "OPENS AT 22:00" as a title: "Opens at 22:00".
const sentence = text => { const t = String(text || '').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const contentState = props => ({ name: NAME, props: JSON.stringify(props) });
// Starts the card on a phone, listening on `channel` (iOS 18), with the notification Apple asks for.
function startPayload(card, channel, now, url = 'courtbooker:///') {
  const p = card.props;
  return { aps: {
    timestamp: seconds(now), event: 'start', 'content-state': contentState(p),
    'attributes-type': 'LiveActivityAttributes', attributes: { url }, 'input-push-channel': channel,
    alert: { title: sentence(p.label), body: `${p.place} · ${p.meta}` },
  } };
}
// A change on the channel; `end`: the last one, gone from the Lock Screen at `dismissAt`.
function updatePayload(card, now, { end = false, dismissAt = 0 } = {}) {
  return { aps: {
    timestamp: seconds(now), event: end ? 'end' : 'update', 'content-state': contentState(card.props),
    ...(end ? { 'dismissal-date': seconds(dismissAt || now) } : {}),
  } };
}

module.exports = { cardFor, startPayload, updatePayload, resultFor, LEAD_MS, BANK_WAIT_MS, NAME };
