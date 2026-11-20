'use strict';
// Paying for a held indoor court from the iPhone app (version 2.9, docs/app-api.md): the card
// given in the app and kept on your PC, and Pay on a court in the basket. The bot's part is to
// pass on what the app sealed for your PC's key (it cannot open it), to check what it can (the
// court is in the basket, a card is kept, the price is the one your PC read), and to follow
// what your PC says: paying, your bank's approval, and how it ended. Whatever is sealed is
// never written to the log or to disk, nor kept once handed over.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../app');
const { createServer } = require('../lib/server');
const A = require('../lib/appapi');
const UI = require('../lib/ui');
const { at, fakeTelegram, memStore, say, PICTURES } = require('./helpers');

const OWNER = 42;
const TUE = '2026-11-17';   // a Tuesday; UK on GMT
const FRI = '2026-11-20';
const NOON = `${TUE}T12:00:00Z`;
const HOME = { ip: '81.2.69.142' };
const AGENT = 'a-long-random-line-for-testing-only';
const HOLD = { centre: 'g', date: FRI, start: 1080, court: 3 };
const TITLE = 'Gorbals · Fri 20 Nov · 18:00–19:00 · Court 3';
const LOOK_UNDER = 'Look under Bookings on Glasgow Club\'s site.';
const PAID_UNKNOWN = 'Whether the payment went through is not known here. Look under Bookings on Glasgow Club\'s site, and in your banking app. Nothing was taken out of your basket.';
const UNHEARD = 'Whether a payment was made is not known here. Look under Bookings on Glasgow Club\'s site, and in your banking app.';
const STRAY = 'I am not following this hold any more (I was restarted while your PC had it), so its card does not change. This is what your PC says:';

// The PC's card key, as its pings give it (an X25519 public key is 32 bytes), and the card it keeps.
const KEY = crypto.randomBytes(32).toString('base64');
const VISA = { brand: 'Visa', last4: '4242', expMonth: 12, expYear: 2030 };
// What the app seals is opaque to the bot: here, bytes of the right sizes. (The PC's own tests seal
// and open real boxes with tweetnacl.) A key (32), a nonce (24), the box's own 16, and what was sealed.
const sealedOf = (n = 60) => crypto.randomBytes(32 + 24 + 16 + n).toString('base64');

const settle = () => new Promise(r => setTimeout(r, 5));
const FREE = [{ start: 1080, end: 1140, court: 3, name: 'Tennis Hall Court 3', opensAt: null }];
function makeBot(t0 = NOON, { linked = true, store = null, pcHoldMs = 25000 } = {}) {
  const clock = { t: at(t0) };
  const tg = fakeTelegram(clock);
  const logs = [], pushes = [];
  store = store || memStore({ v: 4, owner: OWNER, order: [3, 4, 5, 2, 1, 6] });
  const reader = { day: async () => ({ at: clock.t, slots: FREE.map(s => ({ ...s })), listed: 12 }), peek: () => null, health: () => null };
  const app = createApp({
    now: () => clock.t, tg, store, pictures: PICTURES, linked, glasgow: reader, pcLookMs: 2000, pcHoldMs, log: l => logs.push(l), retryMs: 30,
    push: async (tokens, message) => { pushes.push({ tokens, ...message }); }, wake: async () => 3,
  });
  return { app, tg, clock, store, logs, pushes };
}
async function linkPhone(t) {
  await t.app.handleUpdate(say(OWNER, '/app'));
  const code = /Code: <code>(\d{6})<\/code>/.exec(t.tg.last().text)[1];
  const r = t.app.appPair({ code, name: 'iPhone' });
  assert.equal(r.status, 200);
  await settle();
  return { token: r.body.token, id: r.body.device.id, device: t.app.appAuth(r.body.token) };
}
const ask = (t, phone, name, body = {}) => t.app.appAsk(phone.device, name, body);
const stateOf = (t, phone) => t.app.appState(phone.device).state;
const refused = (status, why) => ({ status, body: { ok: false, why } });
// The PC's ping, saying what it says about the card: its key, the card it keeps, and how the last one went.
const pcPing = (t, { kept = VISA, done, key = KEY, wait = 0 } = {}) => t.app.pingFromAgent(HOME, { wait, card: { key, has: true, kept, ...(done ? { done } : {}) } });
// A linked phone, the PC in touch with its key and a card kept.
async function withCard(t0 = NOON, opts = {}) {
  const t = makeBot(t0, opts);
  const phone = await linkPhone(t);
  await pcPing(t);
  return { ...t, phone };
}
// ...and a court from the app in the basket, which the PC says it can pay for.
async function inBasket(t0 = NOON, { pay = 'ready', payWhy } = {}) {
  const t = await withCard(t0);
  const look = await ask(t, t.phone, 'indoor/look', { centre: 'g', date: FRI });
  assert.equal(look.status, 200);
  t.tg.clear();
  const ping = pcPing(t, { wait: 5 });
  assert.equal((await ask(t, t.phone, 'hold', HOLD)).status, 200);
  const order = await ping;
  const id = order.hold.id;
  const pc = (stage, extra = {}) => t.app.holdFromAgent({ id, key: 'g', date: FRI, start: 1080, court: 3, stage, ...extra });
  pc('signing-in');
  pc('signed-in');
  pc('adding');
  pc('held', { price: '£23.00', left: 12 * 60000, ...(pay ? { pay } : {}), ...(payWhy ? { payWhy } : {}) });
  const beat = (extra = {}) => pc('held', { beat: true, price: '£23.00', left: 11 * 60000, pay, ...extra });
  return { ...t, id, pc, beat, hold: () => stateOf(t, t.phone).hold };
}
const PAY = (t, extra = {}) => ({ id: t.id, what: 'pay', amount: '£23.00', sealed: t.cvc || (t.cvc = sealedOf(40)), ...extra });
// Pay asked for in the app, and the order handed to the PC with its next note.
async function told(t0 = NOON) {
  const t = await inBasket(t0);
  assert.equal((await ask(t, t.phone, 'hold/order', PAY(t))).status, 200);
  assert.deepEqual(t.beat(), { ok: true, order: 'pay', amount: '£23.00', sealed: t.cvc });
  return t;
}
// ...and the PC's word that it pressed Pay (`pressed`: true), or may have ('maybe').
async function pressed(pressedHow = true, t0 = NOON) {
  const t = await told(t0);
  assert.deepEqual(t.pc('paying', { price: '£23.00', left: 11 * 60000 }), { ok: true });
  t.clock.t += 9000;
  assert.deepEqual(t.pc('paying', { beat: true, price: '£23.00', pressed: pressedHow, left: 6 * 60000, ...(pressedHow === 'maybe' ? { payWhy: 'Chrome gave no answer when Pay was pressed' } : {}) }), { ok: true });
  return t;
}
// Everything the bot has kept, said or shown, as one text: a sealed box must be in none of it.
function everything(t) {
  return JSON.stringify([t.logs, t.store.load(), t.tg.calls, t.tg.answers, t.pushes, t.phone ? t.app.appState(t.phone.device) : null]);
}

// ---------- the pure parts ----------

test('a sealed box is judged by its size and shape only: canonical base64, at most 1024 characters, at least a key, a nonce and the box', () => {
  for (const n of [2, 60, 1024 * 3 / 4 - 72]) {
    const s = sealedOf(n);
    assert.equal(A.readSealed(s), s, `${n} bytes sealed`);
  }
  assert.equal(sealedOf(1024 * 3 / 4 - 72).length, 1024);
  const long = crypto.randomBytes(1024 * 3 / 4 + 1).toString('base64');                     // 1028 characters
  const short = crypto.randomBytes(32 + 24 + 16 + 1).toString('base64');                     // one byte sealed: not even "{}"
  const ok = Buffer.alloc(133, 0xfb).toString('base64');                                   // with + and /, and padded
  for (const bad of [long, short, '', ok.replace(/=+$/, ''), `${ok} `, ` ${ok}`, `${ok}\n`, ok.replace(/[+/]/g, '-'), Buffer.from(ok, 'base64').toString('base64url'),
    `${ok.slice(0, 40)}\n${ok.slice(40)}`, ok.toLowerCase() === ok ? 'x' : ok.slice(0, -4) + '!!!!', 12, null, undefined, {}, [ok]]) {
    assert.equal(A.readSealed(bad), null, JSON.stringify(bad));
  }
  // Base64 whose last character carries bits a decoder drops is not passed on: what goes to the PC is exactly what came.
  const bytes = crypto.randomBytes(80);
  const canonical = bytes.toString('base64');                                                // 80 bytes: ends with "="
  const loose = canonical.slice(0, -2) + String.fromCharCode(canonical.charCodeAt(canonical.length - 2) ^ 1) + '=';
  if (Buffer.from(loose, 'base64').equals(bytes)) assert.equal(A.readSealed(loose), null);
  assert.equal(A.SEALED_MAX, 1024);
});

test('what the app sends for the card and for Pay must look like, with a plain sentence when it does not', () => {
  const s = sealedOf();
  assert.deepEqual(A.readCard({ sealed: s }), { sealed: s });
  assert.deepEqual(A.readCard({}), { why: A.WHY.card });
  assert.deepEqual(A.readCard({ sealed: 7 }), { why: A.WHY.card });
  assert.deepEqual(A.readCard({ sealed: 'not base64!' }), { why: A.WHY.sealed });
  assert.deepEqual(A.readCard({ number: '4242424242424242', expMonth: 12, expYear: 2030 }), { why: A.WHY.card });   // a card in the clear is never what the bot takes
  assert.deepEqual(A.readForget({}), {});
  assert.deepEqual(A.readForget({ anything: 1 }), {});
  assert.deepEqual(A.readHoldOrder({ id: 'a1b2c3d4e5f6', what: 'pay', amount: '£23.00', sealed: s }), { id: 'a1b2c3d4e5f6', what: 'pay', amount: '£23.00', sealed: s });
  assert.deepEqual(A.readHoldOrder({ id: 'a1b2c3d4e5f6', what: 'pay', amount: '£23', sealed: s }), { id: 'a1b2c3d4e5f6', what: 'pay', amount: '£23', sealed: s });
  for (const bad of [{ amount: '£23.00' }, { sealed: s }, { amount: 23, sealed: s }, { amount: '23.00', sealed: s }, { amount: '£23.0', sealed: s }, { amount: '£23.00 ', sealed: s }, { amount: '£12345.00', sealed: s }, { amount: '£23.00', sealed: 5 }]) {
    assert.deepEqual(A.readHoldOrder({ id: 'a1b2c3d4e5f6', what: 'pay', ...bad }), { why: A.WHY.pay }, JSON.stringify(bad));
  }
  assert.deepEqual(A.readHoldOrder({ id: 'a1b2c3d4e5f6', what: 'pay', amount: '£23.00', sealed: 'abc' }), { why: A.WHY.sealed });
  assert.deepEqual(A.readHoldOrder({ id: 'a1b2c3d4e5f6', what: 'pay!', amount: '£23.00', sealed: s }), { why: A.WHY.holdOrder });
  // What the PC says of its card: a key of 32 bytes, and a card that reads as one, or null.
  assert.equal(A.cleanKey(KEY), KEY);
  for (const bad of [crypto.randomBytes(31).toString('base64'), crypto.randomBytes(33).toString('base64'), KEY.replace('=', ''), Buffer.from(KEY, 'base64').toString('hex'), 7, null]) assert.equal(A.cleanKey(bad), null);
  assert.deepEqual(A.cleanCard(VISA), { ...VISA, tag: null });
  assert.deepEqual(A.cleanCard({ ...VISA, number: '4242424242424242', name: 'x' }), { ...VISA, tag: null });            // nothing beyond these four (and a tag) is ever kept
  assert.equal(A.cleanCard(null), null);
  for (const bad of [{ ...VISA, brand: 'Diners' }, { ...VISA, last4: '424' }, { ...VISA, last4: 4242 }, { ...VISA, expMonth: 13 }, { ...VISA, expYear: 30 }, {}, 'Visa', undefined]) {
    assert.equal(A.cleanCard(bad), undefined, JSON.stringify(bad));
  }
});

// ---------- the card ----------

test('the PC\'s card key comes with its pings and is shown to the app; one that does not read is left out', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  assert.deepEqual([stateOf(t, phone).pc.cardKey, stateOf(t, phone).card], [null, null]);
  await t.app.pingFromAgent(HOME);                                                           // an older PC says nothing of a card
  assert.deepEqual([stateOf(t, phone).pc.cardKey, stateOf(t, phone).card], [null, null]);
  await pcPing(t, { key: 'not a key', kept: { brand: 'Visa' } });
  assert.deepEqual([stateOf(t, phone).pc.cardKey, stateOf(t, phone).card], [null, null]);
  await pcPing(t, { kept: null });
  assert.deepEqual([stateOf(t, phone).pc.cardKey, stateOf(t, phone).card], [KEY, null]);
  await pcPing(t);
  assert.deepEqual(stateOf(t, phone).card, { ...VISA, tag: null, pending: false, forgetting: false, why: null });
  // A ping that says nothing of the card leaves what was known as it was.
  await t.app.pingFromAgent(HOME);
  assert.deepEqual([stateOf(t, phone).pc.cardKey, stateOf(t, phone).card.last4], [KEY, '4242']);
  const other = crypto.randomBytes(32).toString('base64');
  await pcPing(t, { key: other });
  assert.equal(stateOf(t, phone).pc.cardKey, other);
  assert.deepEqual(t.logs.filter(l => /card key/.test(l)), ['Your PC gave me its card key.', 'Your PC has a new card key.']);
  assert.ok(!t.logs.some(l => l.includes(KEY) || l.includes(other)));
});

test('a card from the app: waiting for the PC, handed over on its next ping exactly as it came, and not kept a moment longer', async () => {
  const t = makeBot();
  const phone = await linkPhone(t);
  await pcPing(t, { kept: null });
  const sealed = sealedOf(90);
  const ping = pcPing(t, { kept: null, wait: 5 });                                           // the PC's waiting ping
  const r = await ask(t, phone, 'card', { sealed });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.state.card, { brand: null, last4: null, expMonth: null, expYear: null, tag: null, pending: true, forgetting: false, why: null });
  const order = await ping;
  assert.match(order.card.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(order, { ok: true, card: { id: order.card.id, sealed } });
  assert.equal(t.app.sealedHeld(), 0);                                                        // handed over: dropped
  assert.deepEqual(await pcPing(t, { kept: null }), { ok: true });                           // never twice
  assert.equal(stateOf(t, phone).card.pending, true);                                         // until the PC says how it went
  // The PC kept it: the next ping says so, with the card it keeps now.
  await pcPing(t, { done: { id: order.card.id, ok: true } });
  assert.deepEqual(stateOf(t, phone).card, { ...VISA, tag: null, pending: false, forgetting: false, why: null });
  // The PC says it again (it does until a ping gets through): nothing changes.
  await pcPing(t, { done: { id: order.card.id, ok: true } });
  assert.deepEqual(stateOf(t, phone).card, { ...VISA, tag: null, pending: false, forgetting: false, why: null });
  assert.deepEqual(t.logs.filter(l => /card/i.test(l)), [
    'Your PC gave me its card key.',
    'From the app: card',
    'A card from the app, sealed for your PC, is waiting for it.',
    'Your PC collected the card from the app.',
    'Your PC kept the card from the app (Visa ending 4242).',
  ]);
  assert.ok(!everything({ ...t, phone }).includes(sealed));
});

test('a newer card takes the place of one still waiting; one not collected within two minutes is dropped, and said', async () => {
  const t = await withCard();
  const first = sealedOf(), second = sealedOf();
  assert.equal((await ask(t, t.phone, 'card', { sealed: first })).status, 200);
  assert.equal((await ask(t, t.phone, 'card', { sealed: second })).status, 200);
  assert.equal(t.app.sealedHeld(), 1);                                                        // one at a time
  const order = await pcPing(t);
  assert.equal(order.card.sealed, second);
  assert.ok(t.logs.includes('A newer card from the app takes the place of one still waiting for your PC.'));
  // Not collected in time: dropped, and the app is told why.
  const late = await withCard();
  assert.equal((await ask(late, late.phone, 'card', { sealed: first })).status, 200);
  late.clock.t += 2 * 60000;
  await late.app.tick();
  assert.equal(stateOf(late, late.phone).card.pending, true);
  late.clock.t += 1;
  assert.deepEqual(await pcPing(late), { ok: true });                                         // too old to hand over
  await late.app.tick();
  assert.deepEqual(stateOf(late, late.phone).card, { ...VISA, tag: null, pending: false, forgetting: false, why: 'Your PC did not collect the card within two minutes, so I dropped it. Send it again while your PC is awake.' });
  assert.equal(late.app.sealedHeld(), 0);
  // The next card clears what was said.
  assert.equal((await ask(late, late.phone, 'card', { sealed: second })).body.state.card.why, null);
});

test('the PC would not keep the card, or did not say: the app is told, in the PC\'s words', async () => {
  const t = await withCard();
  await ask(t, t.phone, 'card', { sealed: sealedOf() });
  const order = await pcPing(t);
  await pcPing(t, { done: { id: order.card.id, ok: false, why: 'the card number does not pass the check every card number passes (a digit may be wrong)' } });
  assert.deepEqual(stateOf(t, t.phone).card, { ...VISA, tag: null, pending: false, forgetting: false,
    why: 'Your PC did not keep that card: the card number does not pass the check every card number passes (a digit may be wrong).' });
  // An answer for another card, or one that does not read, is not taken for this one.
  await ask(t, t.phone, 'card', { sealed: sealedOf() });
  const next = await pcPing(t);
  for (const done of [{ id: 'ffffffffffff', ok: true }, { id: next.card.id }, 'yes', { ok: true }]) await pcPing(t, { done });
  assert.equal(stateOf(t, t.phone).card.pending, true);
  // Taken, and no word within two minutes.
  t.clock.t += 2 * 60000 + 1;
  await t.app.tick();
  assert.deepEqual(stateOf(t, t.phone).card, { ...VISA, tag: null, pending: false, forgetting: false,
    why: 'Your PC took the card but did not say whether it kept it. The card shown here is the one your PC says it keeps.' });
});

test('a card is refused while it cannot reach the PC: no card key yet, the PC asleep, or the PC paying', async () => {
  const sealed = sealedOf();
  const b = makeBot();
  const pb = await linkPhone(b);
  await b.app.pingFromAgent(HOME);                                                            // awake, but an older PC: no key
  assert.deepEqual(await ask(b, pb, 'card', { sealed }), refused(409, 'Your PC has not given me its card key yet. It does with every ping while it is awake: wake it, or wait a minute, then try again.'));
  const c = await withCard();
  c.clock.t += 3 * 60000 + 1;                                                                // its last ping was over three minutes ago
  assert.deepEqual(await ask(c, c.phone, 'card', { sealed }), refused(409, 'Your PC is not awake, and it is your PC that keeps the card. Wake it and try again.'));
  const d = await told();
  assert.deepEqual(await ask(d, d.phone, 'card', { sealed }), refused(409, 'Your PC is paying for a court just now. Try again once that is over.'));
  assert.deepEqual(await ask(d, d.phone, 'card/forget'), refused(409, 'Your PC is paying for a court just now. Try again once that is over.'));
  // And the shapes: 400, before anything else.
  assert.deepEqual(await ask(b, pb, 'card', { sealed: 'abc' }), refused(400, A.WHY.sealed));
  assert.deepEqual(await ask(b, pb, 'card', {}), refused(400, A.WHY.card));
  assert.deepEqual(await ask(b, pb, 'card', [1]), refused(400, 'The request body must be a JSON object.'));
  for (const t of [b, c, d]) assert.equal(t.app.sealedHeld(), 0);
});

test('forget: the PC deletes the card it keeps; a card that has not reached the PC goes at once; and there may be nothing to forget', async () => {
  const t = await withCard();
  const r = await ask(t, t.phone, 'card/forget');
  assert.deepEqual([r.status, r.body.state.card], [200, { ...VISA, tag: null, pending: false, forgetting: true, why: null }]);
  const order = await pcPing(t);
  assert.match(order.forgetCard.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(order, { ok: true, forgetCard: { id: order.forgetCard.id } });
  await pcPing(t, { kept: null, done: { id: order.forgetCard.id, ok: true } });
  assert.equal(stateOf(t, t.phone).card, null);
  assert.ok(t.logs.includes('Your PC forgot its card.'));
  // Nothing to forget: the PC says it keeps none.
  assert.deepEqual(await ask(t, t.phone, 'card/forget'), refused(409, 'Your PC keeps no card.'));
  // A card on its way and not yet collected: it goes, unseen by the PC; and the PC, keeping none, is asked nothing.
  await ask(t, t.phone, 'card', { sealed: sealedOf() });
  assert.equal((await ask(t, t.phone, 'card/forget')).body.state.card, null);
  assert.equal(t.app.sealedHeld(), 0);
  assert.deepEqual(await pcPing(t, { kept: null }), { ok: true });
  // A card on its way while the PC keeps another: it goes, and the kept one is forgotten.
  const u = await withCard();
  await ask(u, u.phone, 'card', { sealed: sealedOf() });
  assert.deepEqual((await ask(u, u.phone, 'card/forget')).body.state.card, { ...VISA, tag: null, pending: false, forgetting: true, why: null });
  assert.ok((await pcPing(u)).forgetCard);
  // A card handed over and not yet answered for: forget goes after it, so the PC deletes whatever it then keeps.
  const v = await withCard();
  await ask(v, v.phone, 'card', { sealed: sealedOf() });
  assert.ok((await pcPing(v)).card);
  await ask(v, v.phone, 'card/forget');
  assert.ok((await pcPing(v)).forgetCard);
  // After a restart, before the PC has said which card it keeps: the order goes all the same, and waits for it.
  const w = makeBot();
  const pw = await linkPhone(w);
  assert.equal((await ask(w, pw, 'card/forget')).status, 200);
  w.clock.t += 60 * 60000;                                                                   // a forget waits as long as it takes
  await w.app.tick();
  assert.ok((await pcPing(w)).forgetCard);
  // The PC could not delete it: said.
  const x = await withCard();
  await ask(x, x.phone, 'card/forget');
  const o = await pcPing(x);
  await pcPing(x, { done: { id: o.forgetCard.id, ok: false, why: 'the card file could not be deleted (EPERM)' } });
  assert.deepEqual(stateOf(x, x.phone).card, { ...VISA, tag: null, pending: false, forgetting: false, why: 'Your PC could not forget its card: the card file could not be deleted (EPERM).' });
});

// ---------- Pay ----------

test('a court in the basket that the PC can pay for: can.pay, and Telegram says "Pay from the app" (it has no Pay button)', async () => {
  const t = await inBasket();
  const h = t.hold();
  assert.deepEqual([h.stage, h.can], ['held', { release: true, done: true, pay: true }]);
  assert.deepEqual(h.lines, [
    'In your basket: £23.00 to pay. Your PC signed in as you and put it there at 12:00. The payment page is open in Chrome on your PC.',
    'Pay from the app: your PC pays £23.00 with the card it keeps (Visa ending 4242), once you confirm it there.',
    'Or pay in the Chrome window on your PC, then tap I have paid.',
    'Unpaid, your PC lets it go at 12:12.',
  ]);
  // Its card in Telegram (a Hold tap there brings it): the same words, and no Pay button, nor an "Open my basket".
  const tap = { update_id: 1, callback_query: { id: 'q1', data: 'gh:g:20261120:1900:3', from: { id: OWNER }, message: { message_id: 8, chat: { id: OWNER, type: 'private' } } } };
  await t.app.handleUpdate(tap);
  await settle();
  const card = t.tg.last();
  assert.deepEqual(card.text.split('\n').slice(1).map(A.plain), h.lines);
  assert.deepEqual(card.extra.reply_markup.inline_keyboard.flat().map(b => b.text), ['I have paid', 'Let it go']);
  // The PC cannot pay for it: why, and no can.pay.
  const off = await inBasket(NOON, { pay: 'off', payWhy: 'no card is kept on this PC' });
  assert.deepEqual([off.hold().can.pay, off.hold().lines[1], off.hold().lines[2]], [false, 'Paying from the app is not on for this court: no card is kept on this PC.', 'Pay in the Chrome window on your PC, then tap I have paid.']);
  // An older PC says nothing about paying: nothing is said of it, and Pay is not taken.
  const old = await inBasket(NOON, { pay: '' });
  assert.deepEqual([old.hold().can.pay, old.hold().lines.length, old.hold().lines[1]], [false, 3, 'Pay in the Chrome window on your PC, then tap I have paid.']);
  assert.deepEqual(await ask(old, old.phone, 'hold/order', PAY(old)), refused(409, 'Your PC has not said that it can pay for this court.'));
  // A card added while the court is held: the PC's next note says it can pay now.
  const late = await inBasket(NOON, { pay: 'off', payWhy: 'no card is kept on this PC' });
  late.beat({ pay: 'ready' });
  assert.equal(late.hold().can.pay, true);
});

test('Pay from the app: handed to the PC with its next note, once, with the amount and the sealed code; then paying, approval and booked', async () => {
  const t = await inBasket();
  const cvc = sealedOf(40);
  const r = await ask(t, t.phone, 'hold/order', { id: t.id, what: 'pay', amount: '£23.00', sealed: cvc });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.state.hold.stage, r.body.state.hold.lines, r.body.state.hold.can], ['held', ['In your basket: £23.00 to pay.', 'Telling your PC to pay £23.00, as you asked in the app…'], { release: false, done: false, pay: false }]);
  assert.equal(t.app.sealedHeld(), 1);
  // The PC's next note takes the order; the code goes with it, and is not kept here.
  assert.deepEqual(t.beat(), { ok: true, order: 'pay', amount: '£23.00', sealed: cvc });
  assert.equal(t.app.sealedHeld(), 0);
  // A second tap of Pay, and Let it go or I have paid, are not taken while the PC has it.
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'pay', amount: '£23.00', sealed: sealedOf(40) }), refused(409, 'Your PC has been told to pay for it already.'));
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'release' }), refused(409, 'Your PC has been told to pay. Wait for its answer.'));
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'done' }), refused(409, 'Your PC has been told to pay. Wait for its answer.'));
  // Paying: the PC says so before it types a key.
  assert.deepEqual(t.pc('paying', { price: '£23.00', left: 11 * 60000 }), { ok: true });
  assert.deepEqual([t.hold().stage, t.hold().lines, t.hold().can], ['paying', ['Paying £23.00: your PC is typing in the card it keeps and pressing Pay…'], { release: false, done: false, pay: false }]);
  assert.deepEqual(await ask(t, t.phone, 'hold/order', PAY(t)), refused(409, 'Your PC is paying for it already.'));
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'release' }), refused(409, 'Your PC is paying for it. Wait for its answer.'));
  // Pressed.
  t.clock.t += 12000;
  assert.deepEqual(t.pc('paying', { beat: true, price: '£23.00', pressed: true, left: 6 * 60000 }), { ok: true });
  assert.deepEqual(t.hold().lines, ['Your PC pressed Pay £23.00; I heard so at 12:00. If your bank asks you to approve it, do that in your banking app.', 'Waiting for Glasgow Club\'s answer…']);
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'done' }), refused(409, 'Your PC has pressed Pay. Wait for the answer.'));
  // Your bank wants your approval: the stage, and the time the PC waits until.
  t.clock.t += 4000;
  assert.deepEqual(t.pc('approve', { beat: true, price: '£23.00', pressed: true, left: 5 * 60000 }), { ok: true });
  assert.deepEqual([t.hold().stage, t.hold().until, t.hold().lines], ['approve', t.clock.t + 5 * 60000, [
    'Approve the payment in your banking app. Your bank wants you to approve £23.00 to Glasgow Club before it pays.',
    'Your PC pressed Pay and is waiting for the answer until 12:05.',
  ]]);
  // The check went away (approved): the PC says "paying" again, and the stage stays where it got to.
  t.pc('paying', { beat: true, price: '£23.00', pressed: true, left: 4 * 60000 });
  assert.equal(t.hold().stage, 'approve');
  // Booked: only on the PC's word that the Bookings page lists it.
  t.clock.t += 20000;
  assert.deepEqual(t.pc('booked', { words: 'Thank you. Your booking is confirmed', pressed: true }), { ok: true });
  const h = t.hold();
  assert.deepEqual([h.ended, h.live, h.stage, h.can], ['booked', false, 'approve', { release: false, done: false, pay: false }]);
  assert.deepEqual(h.lines, ['Booked and paid. Your PC pressed Pay, and the court is on your Bookings page at Glasgow Club now; it was not before.', 'After the payment the page said: “Thank you. Your booking is confirmed”']);
  await settle();
  const note = stateOf(t, t.phone).notes[0];
  assert.deepEqual([note.kind, note.title], ['hold', 'Booked · Gorbals court 3']);
  assert.ok(t.logs.includes('Hold: you asked in the app to pay £23.00 for Gorbals 2026-11-20 18:00 court 3 with the card your PC keeps.'));
  assert.ok(t.logs.includes('Hold: the order to pay £23.00 for Gorbals 2026-11-20 18:00 court 3 went to your PC.'));
  assert.ok(t.logs.includes('Hold: your bank wants you to approve the payment for Gorbals 2026-11-20 18:00 court 3.'));
  assert.ok(!everything(t).includes(cvc));
});

test('every refusal of Pay, in its own words, and a price that is not the one your PC read', async () => {
  const t = await inBasket();
  const s = sealedOf(40);
  const pay = (extra = {}) => ask(t, t.phone, 'hold/order', { id: t.id, what: 'pay', amount: '£23.00', sealed: s, ...extra });
  // The amount must be the price your PC read on the payment page: nothing else goes to the PC.
  for (const amount of ['£25.00', '£23', '£2.30', '£0.00']) assert.deepEqual(await pay({ amount }), refused(409, `The price is £23.00, not ${amount}. Look at it again before you pay.`));
  assert.deepEqual(await pay({ amount: '23.00' }), refused(400, A.WHY.pay));
  assert.deepEqual(await pay({ sealed: 'x' }), refused(400, A.WHY.sealed));
  assert.deepEqual(await pay({ id: 'ffffffffffff' }), refused(409, 'I am no longer following that hold. If your PC still has it, it lets it go by itself when its time is up.'));
  assert.deepEqual(t.beat(), { ok: true });                                                   // nothing went to the PC
  // The card: being replaced, being forgotten, or none.
  const sealedCard = sealedOf();
  await ask(t, t.phone, 'card', { sealed: sealedCard });
  assert.deepEqual(await pay(), refused(409, 'Your new card has not reached your PC yet. Try again in a moment.'));
  const o = await pcPing(t);
  assert.deepEqual(await pay(), refused(409, 'Your new card has not reached your PC yet. Try again in a moment.'));
  await pcPing(t, { done: { id: o.card.id, ok: true } });
  await ask(t, t.phone, 'card/forget');
  assert.deepEqual(await pay(), refused(409, 'Your PC is forgetting its card.'));
  const f = await pcPing(t);
  await pcPing(t, { kept: null, done: { id: f.forgetCard.id, ok: true } });
  assert.deepEqual(await pay(), refused(409, 'There is no card on your PC. Add one in the app first.'));
  await pcPing(t);                                                                           // a card kept again
  // The PC's word for this court.
  t.beat({ pay: 'off', payWhy: 'that would be more than 2 payments from this PC today (GLASGOW_PAY_PER_DAY)' });
  assert.deepEqual(await pay(), refused(409, 'Your PC cannot pay for this court: that would be more than 2 payments from this PC today (GLASGOW_PAY_PER_DAY).'));
  t.beat();
  // The PC has gone quiet.
  t.clock.t += 75000;
  await t.app.tick();
  assert.deepEqual(await pay(), refused(409, 'I have not heard from your PC for over a minute, so I am not asking it to pay.'));
  t.beat();
  // Too little time left on the hold.
  t.clock.t = t.hold().until - 29999;
  t.beat();
  assert.deepEqual(await pay(), refused(409, 'Too little of the hold\'s time is left to pay for it from here. Pay at your PC, or let it go.'));
  assert.equal(t.hold().can.pay, false);
  // Before the basket, after Let it go, after I have paid, and over.
  const early = await withCard();
  await ask(early, early.phone, 'indoor/look', { centre: 'g', date: FRI });
  const ping = pcPing(early, { wait: 5 });
  await ask(early, early.phone, 'hold', HOLD);
  const id = (await ping).hold.id;
  early.app.holdFromAgent({ id, stage: 'adding' });
  assert.deepEqual(await ask(early, early.phone, 'hold/order', { id, what: 'pay', amount: '£23.00', sealed: s }), refused(409, 'It is not in your basket yet.'));
  const gone = await inBasket();
  await ask(gone, gone.phone, 'hold/order', { id: gone.id, what: 'release' });
  assert.deepEqual(await ask(gone, gone.phone, 'hold/order', PAY(gone)), refused(409, 'Already letting it go.'));
  const done = await inBasket();
  await ask(done, done.phone, 'hold/order', { id: done.id, what: 'done' });
  assert.deepEqual(await ask(done, done.phone, 'hold/order', PAY(done)), refused(409, 'Already checking.'));
  done.pc('unsure', { checked: true, basket: 'still' });
  assert.deepEqual(await ask(done, done.phone, 'hold/order', PAY(done)), refused(409, 'That hold is over.'));
  // The price did not read: no Pay.
  const noPrice = await inBasket();
  noPrice.app.holdFromAgent({ id: 'ffffffffffff', stage: 'held' });                           // (not this hold)
  const np = await withCard();
  await ask(np, np.phone, 'indoor/look', { centre: 'g', date: FRI });
  const p2 = pcPing(np, { wait: 5 });
  await ask(np, np.phone, 'hold', HOLD);
  const id2 = (await p2).hold.id;
  np.app.holdFromAgent({ id: id2, stage: 'held', price: 'free!', left: 12 * 60000, pay: 'ready' });
  assert.deepEqual(await ask(np, np.phone, 'hold/order', { id: id2, what: 'pay', amount: '£23.00', sealed: s }), refused(409, 'Your PC could not read the price, so it cannot pay for this court.'));
  for (const x of [t, early, gone, done, noPrice, np]) assert.equal(x.app.sealedHeld(), 0);
});

test('an order the PC never came for is dropped after half a minute, unsent: nothing was pressed, and Pay may be asked for again', async () => {
  const t = await inBasket();
  await ask(t, t.phone, 'hold/order', PAY(t));
  t.clock.t += 30000;
  await t.app.tick();
  assert.equal(t.hold().lines[1], 'Telling your PC to pay £23.00, as you asked in the app…');
  t.clock.t += 1;
  await t.app.tick();
  assert.equal(t.app.sealedHeld(), 0);
  assert.deepEqual(t.hold().lines.slice(1, 3), [
    'Not paid from the app: your PC did not come for it within half a minute. Your PC pressed nothing, so you can ask again there.',
    'Pay from the app: your PC pays £23.00 with the card it keeps (Visa ending 4242), once you confirm it there.',
  ]);
  assert.deepEqual(t.beat(), { ok: true });                                                   // never handed over late
  // Asked again: it goes.
  const again = sealedOf(40);
  assert.equal((await ask(t, t.phone, 'hold/order', PAY(t, { sealed: again }))).status, 200);
  assert.deepEqual(t.beat(), { ok: true, order: 'pay', amount: '£23.00', sealed: again });
});

test('an order that did not reach the PC: its next notes are from the basket, not "paying", so nothing was pressed and Pay may be asked for again', async () => {
  const t = await told();
  // One note from the basket may be an older one, slow on the way and overtaken by the one that took the order: nothing changes for it.
  assert.deepEqual(t.beat(), { ok: true });
  assert.deepEqual([t.hold().can.pay, t.hold().lines[1]], [false, 'Telling your PC to pay £23.00, as you asked in the app…']);
  const slow = await told();
  slow.beat();
  slow.pc('paying', { price: '£23.00', left: 11 * 60000 });                                      // and then the PC says it is paying: it had the order all along
  assert.deepEqual([slow.hold().stage, slow.hold().can.pay], ['paying', false]);
  // Two: it never got there.
  assert.deepEqual(t.beat(), { ok: true });
  const h = t.hold();
  assert.deepEqual([h.stage, h.can.pay, h.lines[1]], ['held', true, 'Not paid from the app: your PC did not get the order to pay. Your PC pressed nothing, so you can ask again there.']);
  assert.ok(t.logs.includes('Hold: the order to pay for Gorbals 2026-11-20 18:00 court 3 was dropped (your PC did not get the order to pay).'));
  // The PC told to pay and then not a word for half a minute: the card says where to look.
  const q = await told();
  q.clock.t += 30001;
  await q.app.tick();
  assert.deepEqual(q.hold().lines, ['In your basket: £23.00 to pay.', 'Your PC was told to pay and has not said how it went. Before you pay any other way, look at the Chrome window on your PC, under Bookings on Glasgow Club\'s site and in your banking app.']);
});

test('the PC could not pay: it says why, nothing was pressed, and it does not try again; the court can still be let go', async () => {
  const t = await told();
  assert.deepEqual(t.beat({ pay: 'failed', payWhy: 'the payment page says "Pay £25.00", not the £23.00 you confirmed' }), { ok: true });
  const h = t.hold();
  assert.deepEqual([h.stage, h.can], ['held', { release: true, done: true, pay: false }]);
  assert.deepEqual(h.lines.slice(1), [
    'Your PC could not pay: the payment page says "Pay £25.00", not the £23.00 you confirmed. Your PC pressed nothing.',
    'Pay in the Chrome window on your PC, then tap I have paid.',
    'Unpaid, your PC lets it go at 12:12.',
  ]);
  assert.deepEqual(await ask(t, t.phone, 'hold/order', PAY(t)), refused(409, 'Your PC tried to pay for it once and could not, so it will not try again. Pay at your PC, or let it go.'));
  assert.equal((await ask(t, t.phone, 'hold/order', { id: t.id, what: 'release' })).status, 200);
  assert.deepEqual(t.beat({ pay: 'failed', payWhy: 'x' }), { ok: true, order: 'release' });
  // It stopped after typing, before the press: the stage goes back to the basket, unpaid.
  const s = await told();
  s.pc('paying', { price: '£23.00', left: 11 * 60000 });
  assert.equal(s.hold().stage, 'paying');
  s.pc('held', { beat: true, price: '£23.00', left: 10 * 60000, pay: 'failed', payWhy: 'the security code box: it did not hold what was typed (it read like "")' });
  assert.deepEqual([s.hold().stage, s.hold().can.release, s.hold().lines[1]], ['held', true,
    'Your PC could not pay: the security code box: it did not hold what was typed (it read like ""). Your PC pressed nothing.']);
});

test('a second order to pay is never sent while one is going, and nothing goes once Pay has been pressed', async () => {
  const t = await pressed();
  for (const [what, why] of [['pay', 'Your PC is paying for it already.'], ['release', 'Your PC has pressed Pay. Wait for the answer.'], ['done', 'Your PC has pressed Pay. Wait for the answer.']]) {
    assert.deepEqual(await ask(t, t.phone, 'hold/order', what === 'pay' ? PAY(t, { sealed: sealedOf(40) }) : { id: t.id, what }), refused(409, why), what);
  }
  // Notes go on being answered with nothing to do: the PC is never told to let go after a press.
  for (let i = 0; i < 3; i++) assert.deepEqual(t.pc('paying', { beat: true, price: '£23.00', pressed: true, left: 5 * 60000 }), { ok: true });
  assert.equal(t.app.sealedHeld(), 0);
});

test('the PC dies in the middle of paying: what is known of the press is said with the ending, and the PC is never told to let go', async () => {
  // Pressed, and then the PC link says its tool has gone.
  const a = await pressed();
  assert.deepEqual(a.pc('gone', { why: 'the booking tool was still running after twenty-eight minutes, so it was stopped' }), { ok: true });
  assert.deepEqual(a.hold().lines, ['Your PC pressed Pay, and then the tool on your PC stopped without saying how it ended (the booking tool was still running after twenty-eight minutes, so it was stopped).', PAID_UNKNOWN]);
  // Paying, not yet pressed as far as the bot heard, and the link says a press had been noted before the tool went.
  const b = await told();
  b.pc('paying', { price: '£23.00', left: 11 * 60000 });
  b.pc('gone', { pressed: 'maybe' });
  assert.deepEqual(b.hold().lines, ['Your PC may have pressed Pay (whether it did is not known), and then the tool on your PC stopped without saying how it ended.', PAID_UNKNOWN]);
  // Paying, and the tool went with nothing noted: the order went out and how it went is not known.
  const c = await told();
  c.pc('paying', { price: '£23.00', left: 11 * 60000 });
  c.pc('gone');
  assert.deepEqual(c.hold().lines, ['You confirmed Pay and your PC was told to pay, but it never said how that went, and then the tool on your PC stopped without saying how it ended.', UNHEARD]);
  // Nothing more heard at all after the press: the bot's own ending says the same, and the PC is not told to let go.
  const d = await pressed();
  d.clock.t += 6 * 60000 + 7 * 60000 - 1;
  await d.app.tick();
  assert.equal(d.hold().ended, null);                                                         // seven minutes after its time, not before
  d.clock.t += 1;
  await d.app.tick();
  assert.deepEqual([d.hold().ended, d.hold().lines], ['timeout', ['Your PC pressed Pay, and I have heard nothing more from your PC about this.', PAID_UNKNOWN]]);
  assert.deepEqual(d.pc('paying', { beat: true, price: '£23.00', pressed: true, left: 0 }), { ok: true });
  // ...and its own word on how it ended, when it comes, replaces the bot's guess.
  d.pc('booked', { pressed: true, words: '' });
  assert.equal(d.hold().lines[0], 'Booked and paid. Your PC pressed Pay, and the court is on your Bookings page at Glasgow Club now; it was not before.');
  // Told, and then silence: "unheard".
  const e = await told();
  e.clock.t += 20 * 60000;
  await e.app.tick();
  assert.deepEqual(e.hold().lines, ['You confirmed Pay and your PC was told to pay, but it never said how that went, and I have heard nothing more from your PC about this.', UNHEARD]);
  assert.deepEqual(e.beat(), { ok: true });                                                    // not "let it go"
  // The Chrome window closed, or the PC asleep, after the press.
  for (const [how, first] of [['closed', 'Your PC pressed Pay, and then the Chrome window on your PC was closed, so I cannot see how it ended.'], ['slept', 'Your PC pressed Pay, and then your PC went to sleep, so it stopped there.']]) {
    const f = await pressed();
    f.pc(how, { pressed: true });
    assert.deepEqual(f.hold().lines, [first, PAID_UNKNOWN], how);
  }
  // The note for the app carries it too.
  await settle();
  assert.match(stateOf(a, a.phone).notes[0].body, /Your PC pressed Pay, and then the tool on your PC stopped/);
});

test('your bank\'s approval does not come in time, a code is asked for, or the payment does not go through: each said as it is', async () => {
  // Approval asked for, and none came while the PC waited.
  const a = await pressed();
  a.pc('approve', { beat: true, price: '£23.00', pressed: true, left: 5 * 60000 });
  a.clock.t += 5 * 60000;
  assert.deepEqual(a.pc('unsure', { pressed: true, bank: 'approve', checked: true, basket: 'still' }), { ok: true });
  assert.deepEqual(a.hold().lines, [
    'Your PC pressed Pay and your bank asked you to approve the payment, but no approval had come when your PC stopped waiting, and I could not see the court as a new booking on your Bookings page.',
    `It is still in the basket on your PC, so it does not look paid for. I left it there; unpaid, it lapses by itself. I have closed Chrome on your PC. ${LOOK_UNDER} Look in your banking app too: if the money has gone and the court is not under Bookings, that is one for Glasgow Club.`,
  ]);
  // The bank's approval wait outlasting the hold's own time: the bot waits on the PC's clock, not its own.
  const w = await pressed();
  w.clock.t += 5 * 60000;
  w.pc('approve', { beat: true, price: '£23.00', pressed: true, left: 5 * 60000 });
  w.clock.t += 5 * 60000 + 7 * 60000 - 1;
  await w.app.tick();
  assert.equal(w.hold().ended, null);
  // A code asked for: the PC never types one, nor passes one on.
  const c = await pressed();
  assert.deepEqual(c.pc('failed', { pressed: true, bank: 'code', why: 'your bank asked for a code to be typed into the payment page, and I never type or pass on such a code' }), { ok: true });
  assert.deepEqual(c.hold().lines, [
    'Your PC pressed Pay, and then your bank asked for a code to be typed into the payment page. Your PC never types or passes on such a code, so it stopped there, and the payment may not have gone through.',
    `Nothing was taken out of your basket; unpaid, the court lapses by itself. ${LOOK_UNDER} Look in your banking app too.`,
  ]);
  // The payment page came back with an error.
  const d = await pressed();
  d.pc('failed', { pressed: true, why: 'the payment did not go through: the payment page came back with its Pay button and an error', words: 'Your card was declined', checked: true, basket: 'still' });
  assert.deepEqual(d.hold().lines, [
    'Your PC pressed Pay, but the payment did not go through: the payment page came back with its Pay button and an error.',
    'The payment page said: “Your card was declined”',
    `Nothing was taken out of your basket; unpaid, the court lapses by itself. ${LOOK_UNDER} Look in your banking app too.`,
  ]);
  // It stopped while paying, before the press (its own word: no press was noted).
  const e = await told();
  e.pc('paying', { price: '£23.00', left: 11 * 60000 });
  e.pc('failed', { why: 'it stopped: Chrome stopped answering' });
  assert.deepEqual(e.hold().lines, ['Your PC stopped paying before it pressed Pay: it stopped: Chrome stopped answering.', `Your PC pressed nothing; a court left unpaid lapses by itself. ${LOOK_UNDER}`]);
});

test('"may have pressed": said as that on the hold, and from then on treated as pressed', async () => {
  const t = await pressed('maybe');
  assert.deepEqual(t.hold().lines, [
    'Your PC may have pressed Pay £23.00: Chrome gave no answer when Pay was pressed. I heard so at 12:00.',
    'Take it as pressed. Before you pay any other way, look under Bookings on Glasgow Club\'s site and in your banking app. If your bank asks you to approve this payment, that is yours to decide.',
    'Your PC takes nothing out of your basket, and is waiting for Glasgow Club\'s answer…',
  ]);
  // A later note does not make it certain.
  t.pc('paying', { beat: true, price: '£23.00', pressed: true, left: 5 * 60000 });
  assert.match(t.hold().lines[0], /^Your PC may have pressed Pay £23\.00/);
  assert.deepEqual(await ask(t, t.phone, 'hold/order', { id: t.id, what: 'release' }), refused(409, 'Your PC may have pressed Pay. Wait for the answer.'));
  t.pc('slept', {});
  assert.deepEqual(t.hold().lines, ['Your PC may have pressed Pay (whether it did is not known), and then your PC went to sleep, so it stopped there.', PAID_UNKNOWN]);
});

test('the bot restarted while the PC paid: you are told in a message and a note, once while it goes on and once with how it ended', async () => {
  const fresh = makeBot(`${TUE}T12:05:00Z`);
  const phone = await linkPhone(fresh);
  fresh.tg.clear();
  const beat = { id: 'a1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, stage: 'paying', beat: true, price: '£23.00', pressed: true, left: 4 * 60000 };
  for (let i = 0; i < 4; i++) assert.deepEqual(fresh.app.holdFromAgent(beat), { ok: true, unknown: true });
  await settle();
  assert.equal(fresh.tg.calls.length, 1);
  assert.deepEqual(fresh.tg.last().text.split('\n'), [
    `<b>${TITLE}</b>`,
    STRAY,
    'Your PC pressed Pay, and it is waiting for Glasgow Club\'s answer. If your bank asks you to approve the payment, do that in your banking app.',
    `${PAID_UNKNOWN} I will say here how it ended, if your PC tells me.`,
  ]);
  let notes = stateOf(fresh, phone).notes;
  assert.deepEqual([notes.length, notes[0].kind, notes[0].title], [1, 'hold', 'Paying · Gorbals court 3']);
  assert.ok(notes[0].body.startsWith(`Fri 20 Nov · 18:00–19:00. ${STRAY} Your PC pressed Pay, and it is waiting`));
  // The bank's approval is still "going on": not said again.
  fresh.app.holdFromAgent({ ...beat, stage: 'approve' });
  // The ending.
  fresh.app.holdFromAgent({ id: 'a1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, stage: 'booked', words: '', pressed: true });
  fresh.app.holdFromAgent({ id: 'a1b2c3d4e5f6', stage: 'gone' });
  await settle();
  assert.equal(fresh.tg.calls.length, 2);
  assert.equal(fresh.tg.last().text.split('\n')[2], '<b>Booked and paid.</b> Your PC pressed Pay, and the court is on your Bookings page at Glasgow Club now; it was not before.');
  notes = stateOf(fresh, phone).notes;
  assert.deepEqual(notes.map(n => n.title), ['Booked · Gorbals court 3', 'Paying · Gorbals court 3']);
  // The PC could not pay, after a restart: said once, as a note too.
  const other = makeBot(`${TUE}T12:05:00Z`);
  const p2 = await linkPhone(other);
  const failed = { id: 'b1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, stage: 'held', beat: true, price: '£23.00', pay: 'failed', payWhy: 'the security code was sealed for another payment' };
  other.app.holdFromAgent(failed);
  other.app.holdFromAgent(failed);
  await settle();
  assert.equal(other.tg.calls.filter(c => c.method === 'send' && c.text.includes(STRAY)).length, 1);
  assert.deepEqual(stateOf(other, p2).notes.map(n => n.title), ['Not paid · Gorbals court 3']);
});

test('nothing sealed is ever written to the log, to disk, to Telegram or to the app, over HTTP as in the app itself', async () => {
  const t = await inBasket();
  const card = sealedOf(120), cvc = sealedOf(40);
  const logs = [];
  const a = t.app;
  const appApi = { hello: a.appHello, pair: a.appPair, auth: a.appAuth, state: a.appState, ask: a.appAsk };
  const server = createServer({ getJobs: a.jobsForAgent, onResult: a.resultFromAgent, onPing: a.pingFromAgent, onLook: a.lookFromAgent, onHold: a.holdFromAgent, onProgress: a.progressFromAgent,
    token: AGENT, appApi, appPollMs: 15, log: l => logs.push(l) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, auth) => {
    const res = await fetch(base + path, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const phone = `Bearer ${t.phone.token}`, pc = `Bearer ${AGENT}`;
  try {
    // The card: from the app, to the PC's ping, and the PC's answer.
    assert.equal((await call('POST', '/app/card', { sealed: card }, phone)).status, 200);
    const ping = await call('POST', '/agent/ping', { awake: true, cardKey: KEY, card: VISA }, pc);
    assert.deepEqual(ping, { status: 200, json: { ok: true, card: { id: ping.json.card.id, sealed: card } } });
    const answered = await call('POST', '/agent/ping', { awake: true, cardKey: KEY, card: { brand: 'Mastercard', last4: '4444', expMonth: 1, expYear: 2031 }, cardDone: { id: ping.json.card.id, ok: true } }, pc);
    assert.deepEqual(answered, { status: 200, json: { ok: true } });
    const state = (await call('GET', '/app/state', undefined, phone)).json.state;
    assert.deepEqual([state.pc.cardKey, state.card], [KEY, { brand: 'Mastercard', last4: '4444', expMonth: 1, expYear: 2031, tag: null, pending: false, forgetting: false, why: null }]);
    // Pay: from the app, to the PC's next note.
    assert.equal((await call('POST', '/app/hold/order', { id: t.id, what: 'pay', amount: '£23.00', sealed: cvc }, phone)).status, 200);
    const note = await call('POST', '/agent/hold', { id: t.id, key: 'g', date: FRI, start: 1080, court: 3, stage: 'held', beat: true, price: '£23.00', left: 600000, pay: 'ready' }, pc);
    assert.deepEqual(note, { status: 200, json: { ok: true, order: 'pay', amount: '£23.00', sealed: cvc } });
    // A sealed box that is too large is turned away at the door (the app's 4 KB), or by its shape.
    assert.deepEqual(await call('POST', '/app/card', { sealed: 'A'.repeat(5000) }, phone), { status: 413, json: { ok: false, why: 'That request is too large.' } });
    assert.deepEqual(await call('POST', '/app/card', { sealed: `${'A'.repeat(1028)}` }, phone), { status: 400, json: { ok: false, why: A.WHY.sealed } });
  } finally { await new Promise(r => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }); }
  assert.equal(t.app.sealedHeld(), 0);
  const all = `${everything(t)}${JSON.stringify(logs)}`;
  for (const s of [card, cvc, card.slice(0, 40), cvc.slice(0, 40)]) assert.ok(!all.includes(s));
  assert.ok(t.logs.includes('From the app: card'));
});

// ---------- the card in Telegram, at its longest ----------

test('every new card of a hold fits in Telegram, and none has a Pay button', () => {
  const ctx = { cfg: { plan: {}, once: [], order: [3, 4, 5, 2, 1, 6], releaseMin: 1320, daysAhead: 7 }, now: at(`${TUE}T12:05:00Z`), paused: false, results: {}, lastSeen: null, linked: true, pc: 'awake', wake: 'ready', card: VISA };
  const base = { id: 'a1b2c3d4e5f6', key: 'g', date: FRI, start: 1080, court: 3, taken: true, stage: 'held', end: null, order: null, price: '£1234.00', heldAt: at(NOON), until: at(`${TUE}T12:12:00Z`),
    why: '', basket: '', removed: null, words: '', checked: false, silent: false, pay: 'ready', payWhy: '', payState: null, payAmount: '£1234.00', payFailed: '', payDoubt: '', payWords: '', pressedAt: at(NOON), pressed: false, bank: '', payQuiet: false };
  const long = '<'.repeat(300);
  const cases = [
    {}, { pay: 'off', payWhy: long.slice(0, 200) }, { payState: 'asked' }, { payState: 'told', payQuiet: true }, { payState: 'failed', payFailed: long.slice(0, 200) }, { payState: 'lost', payFailed: long.slice(0, 200) },
    { stage: 'paying', payState: 'paying' }, { stage: 'paying', payState: 'paying', pressed: true, payWords: long }, { stage: 'paying', payState: 'paying', pressed: 'maybe', payDoubt: long.slice(0, 160), payWords: long },
    { stage: 'approve', payState: 'paying', pressed: true, payWords: long, silent: true },
    { end: 'failed', stage: 'approve', pressed: true, bank: 'code', why: long }, { end: 'failed', stage: 'paying', pressed: true, why: long, words: long }, { end: 'failed', stage: 'paying', why: long },
    { end: 'unsure', stage: 'approve', pressed: true, bank: 'approve', words: long, basket: 'still' }, { end: 'unsure', stage: 'approve', pressed: 'maybe', bank: 'approve', words: long, basket: 'unclear' },
  ];
  const seen = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const over of cases) {
    const s = UI.indoorHold(ctx, { ...base, ...over });
    assert.ok(seen(s.caption).length <= 1024, `${JSON.stringify(over).slice(0, 80)}: ${seen(s.caption).length}`);
    for (const b of s.keyboard.inline_keyboard.flat()) {
      assert.ok(!/^Pay\b/.test(b.text), b.text);
      if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    }
    assert.ok(!s.caption.includes('<<'));                                                    // the PC's words are escaped
  }
});

test('asked for while the PC could pay, and its next note says it cannot: the order is not sent', async () => {
  const t = await inBasket();
  assert.equal((await ask(t, t.phone, 'hold/order', PAY(t))).status, 200);
  assert.deepEqual(t.beat({ pay: 'off', payWhy: 'no card is kept on this PC' }), { ok: true });
  assert.equal(t.app.sealedHeld(), 0);
  assert.deepEqual([t.hold().can.pay, t.hold().lines[1]], [false, 'Not paid from the app: your PC cannot pay for this court just now: no card is kept on this PC. Your PC pressed nothing, so you can ask again there.']);
  assert.deepEqual(t.beat(), { ok: true });                                                   // nothing goes later either
});

// ---------- 2.9.1: the card's tag; and what a refusal from your PC says ----------

test('the card your PC keeps carries its tag (from the pay key), and only a tag of 8 hex characters is passed on', async () => {
  const t = await withCard();
  await pcPing(t, { kept: { ...VISA, tag: '60bf07c4' } });
  assert.deepEqual(stateOf(t, t.phone).card, { ...VISA, tag: '60bf07c4', pending: false, forgetting: false, why: null });
  for (const bad of ['60BF07C4', '60bf07c', '60bf07c4a', 'xyzxyzxy', 1234, null, { a: 1 }]) {
    assert.deepEqual(A.cleanCard({ ...VISA, tag: bad }), { ...VISA, tag: null }, JSON.stringify(bad));
  }
  // A PC whose booker is older says no tag: null, and the card is shown all the same.
  await pcPing(t, { kept: VISA });
  assert.equal(stateOf(t, t.phone).card.tag, null);
});

test('a refusal from your PC says what your PC did, never that nothing was paid: somebody may be paying in that window', async () => {
  const t = await told();
  const busy = 'someone is already paying in the Chrome window on your PC (the card number box already holds something), so nothing was typed';
  assert.deepEqual(t.beat({ pay: 'failed', payWhy: busy }), { ok: true });
  const lines = t.hold().lines;
  assert.ok(lines.includes(`Your PC could not pay: ${busy}. Your PC pressed nothing.`), lines.join(' | '));
  assert.ok(!lines.join(' ').includes('nothing was paid'));
});
