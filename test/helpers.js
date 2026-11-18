'use strict';
// Stand-ins for Telegram, storage and the clock, so a whole release night can be replayed in a test.

const at = s => Date.parse(s);

// A picture arrives either as a file ({ buf, name }) or as the id Telegram gave it earlier.
const nameOf = photo => (typeof photo === 'string' ? photo : `upload:${photo.name}`);
const sizesOf = photo => [{ file_id: 'thumb' }, { file_id: typeof photo === 'string' ? photo : `id:${photo.name}` }];
function refuse(tg, photo) {
  let message = null;
  if (tg.refusePhotos) message = 'Bad Request: PHOTO_INVALID_DIMENSIONS';
  else if (typeof photo === 'string' && tg.staleIds.has(photo)) message = 'Bad Request: wrong file identifier/HTTP URL specified';
  if (message) { const e = new Error(message); e.code = 400; throw e; }
}
// Tiny stand-ins for the banner pictures, as the app loads them from assets/.
const PICTURES = Object.fromEntries(['home-awake', 'home-asleep', 'home-offline', 'booked', 'missed']
  .map(k => [k, { buf: Buffer.from(`${k} picture`), name: `banner-${k}.jpg`, hash: `hash-${k}` }]));

function fakeTelegram(clock) {
  let nextId = 100;
  const tg = {
    calls: [],
    failSend: 0,        // how many of the next sends should fail
    failEdit: null,     // { code, message, once }
    async send(chat, text, extra = {}) {
      if (tg.failSend > 0) { tg.failSend--; throw new Error('network down'); }
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
      tg.calls.push({ at: clock.t, method: 'edit', chat, text, extra, id });
      return true;
    },
    // ---- pictures ----
    refusePhotos: false,      // answer every picture as Telegram does one it will not accept
    staleIds: new Set(),      // picture ids that Telegram no longer recognises
    failMedia: null,          // { code, message, once } for changing a message's picture
    async sendPhoto(chat, photo, extra = {}) {
      if (tg.failSend > 0) { tg.failSend--; throw new Error('network down'); }
      refuse(tg, photo);
      const id = nextId++;
      tg.calls.push({ at: clock.t, method: 'photo', chat, text: extra.caption, extra, id, photo: nameOf(photo) });
      return { message_id: id, photo: sizesOf(photo) };
    },
    async editCaption(chat, id, caption, extra = {}) {
      if (tg.failEdit) {
        const e = new Error(tg.failEdit.message || 'edit failed'); e.code = tg.failEdit.code;
        if (tg.failEdit.once) tg.failEdit = null;
        throw e;
      }
      tg.calls.push({ at: clock.t, method: 'caption', chat, text: caption, extra, id });
      return { message_id: id };
    },
    async editMedia(chat, id, photo, extra = {}) {
      if (tg.failMedia) {
        const e = new Error(tg.failMedia.message || 'media failed'); if (tg.failMedia.code) e.code = tg.failMedia.code;
        if (tg.failMedia.once) tg.failMedia = null;
        throw e;
      }
      refuse(tg, photo);
      tg.calls.push({ at: clock.t, method: 'media', chat, text: extra.caption, extra, id, photo: nameOf(photo) });
      return { message_id: id, photo: sizesOf(photo) };
    },
    // ---- button taps ----
    answers: [],
    async answer(id, text) { tg.answers.push(text ?? null); return true; },
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

module.exports = { at, fakeTelegram, memStore, say, run, runLikeIndex, clockOf, PICTURES };
