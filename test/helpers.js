'use strict';
// Stand-ins for Telegram, storage and the clock, so a whole release night can be replayed in a test.

const at = s => Date.parse(s);

function refuseIfColoured(tg, extra) {
  const rows = (extra.reply_markup || {}).inline_keyboard || [];
  if (tg.refuseColours && rows.some(r => r.some(b => b.style))) {
    const e = new Error("Bad Request: can't parse inline keyboard button: unsupported style"); e.code = 400; throw e;
  }
}

function fakeTelegram(clock) {
  let nextId = 100;
  const tg = {
    calls: [],
    failSend: 0,        // how many of the next sends should fail
    failEdit: null,     // { code, message, once }
    refuseColours: false,   // answer like an API that does not accept coloured buttons
    async send(chat, text, extra = {}) {
      if (tg.failSend > 0) { tg.failSend--; throw new Error('network down'); }
      refuseIfColoured(tg, extra);
      const id = nextId++;
      tg.calls.push({ at: clock.t, method: 'send', chat, text, extra, id });
      return { message_id: id };
    },
    async edit(chat, id, text, extra = {}) {
      if (tg.failEdit) {
        const e = new Error(tg.failEdit.message || 'edit failed'); e.code = tg.failEdit.code;
        if (tg.failEdit.once) tg.failEdit = null;
        throw e;
      }
      refuseIfColoured(tg, extra);
      tg.calls.push({ at: clock.t, method: 'edit', chat, text, extra, id });
      return true;
    },
    skewMs: () => 0,
    last: () => tg.calls[tg.calls.length - 1],
    clear: () => { tg.calls.length = 0; },
  };
  return tg;
}

function memStore(initial = null, persistent = true) {
  let saved = initial === null ? null : JSON.stringify(initial);
  return {
    load: () => (saved === null ? null : JSON.parse(saved)),
    save: s => { saved = JSON.stringify(s); return true; },
    isPersistent: () => persistent,
    file: '(memory)',
  };
}

const say = (chat, text, type = 'private') => ({ update_id: 1, message: { message_id: 1, chat: { id: chat, type }, text } });

// Step the clock in fixed steps, ticking the app each time.
async function run(app, clock, from, to, step = 100) {
  for (clock.t = at(from); clock.t <= at(to); clock.t += step) await app.tick();
}
// Step the clock the way index.js does: every 100 ms, or straight to the next message when one is close.
async function runLikeIndex(app, clock, from, to) {
  clock.t = at(from);
  while (clock.t <= at(to)) {
    await app.tick();
    const ms = app.msToNext();
    clock.t += ms === null ? 100 : Math.max(2, Math.min(100, ms));
  }
}
const clockOf = ms => new Date(ms).toISOString();

module.exports = { at, fakeTelegram, memStore, say, run, runLikeIndex, clockOf };
