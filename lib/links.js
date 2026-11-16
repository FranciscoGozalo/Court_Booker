'use strict';
// Builds links into ClubSpark's own pages for Kelvingrove Park Tennis Courts.
// These are plain links for a person to tap. Nothing here contacts ClubSpark.

const { iso } = require('./time');

const SHEET = 'https://clubspark.lta.org.uk/KelvingroveParkTennisCourts/Booking/BookByDate';
const BOOK = 'https://clubspark.lta.org.uk/KelvingroveParkTennisCourts/Booking/Book';
const VENUE = '44c8485b-ba20-4617-b364-445810cb9212';
const COURTS = {
  1: '975d8ce1-14ec-43aa-b152-98b71f16e850',
  2: '83d4fedf-f1e1-4ace-a34b-6000d23db0b2',
  3: '2a80f605-154c-4d98-a7dd-03c9e2ef1055',
  4: '41c43943-426c-422d-adf6-d84367f60067',
  5: '88e584bb-fe5c-427b-bc10-1cd98e429a0c',
  6: 'f49c7d5d-77d4-4321-a48e-f20366bae208',
};
// The booking code from a confirm-screen address captured on 16 Nov 2026. That evening it
// opened the confirm screen for other courts, other days, evening slots, 2-hour bookings
// and a day released that night. Replace it with /code if the venue changes its schedule.
const DEFAULT_SID = 'ff6ac50a-dbea-4388-90d7-dcc8332240fd';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The booking sheet for a day.
function sheetUrl(c) { return `${SHEET}#?date=${iso(c)}&role=guest`; }

// ClubSpark's confirm screen for one court, day and time.
function directUrl(courtNo, c, start, end, sid) {
  return `${BOOK}?Contacts%5B0%5D.IsPrimary=true&Contacts%5B0%5D.IsJunior=false&Contacts%5B0%5D.IsPlayer=true`
    + `&ResourceID=${COURTS[courtNo]}&Date=${iso(c)}&SessionID=${sid}`
    + `&StartTime=${start}&EndTime=${end}`
    + `&Category=0&SubCategory=0&VenueID=${VENUE}&ResourceGroupID=${VENUE}`;
}

// Read the booking code out of a confirm-screen address. Only the code is kept.
function parseBookAddress(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch { return { ok: false, why: 'That is not a web address. Copy it from the address bar on the confirm screen.' }; }
  if (u.hostname.toLowerCase() !== 'clubspark.lta.org.uk' || u.pathname.toLowerCase() !== '/kelvingroveparktenniscourts/booking/book') {
    return { ok: false, why: 'That is not the Kelvingrove confirm screen. Tap a free slot, then Continue booking, and copy the address of the screen that follows.' };
  }
  const sid = u.searchParams.get('SessionID') || '';
  if (!GUID.test(sid)) return { ok: false, why: 'That address has no booking code in it.' };
  const res = (u.searchParams.get('ResourceID') || '').toLowerCase();
  const court = Number(Object.keys(COURTS).find(n => COURTS[n] === res) || 0);
  return { ok: true, sid: sid.toLowerCase(), court };
}

module.exports = { SHEET, BOOK, VENUE, COURTS, DEFAULT_SID, GUID, sheetUrl, directUrl, parseBookAddress };
