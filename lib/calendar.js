'use strict';
// Your booked courts as a calendar feed (iCalendar), for a phone to subscribe to. The feed
// sits at an address only you know (a long random token in it), and nothing else guards it.

const { londonInstant } = require('./time');
const { civilOf } = require('./schedule');

const VENUE = 'Kelvingrove Park Tennis Courts, Glasgow';

// 20261126T180000Z
const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
// Words in a calendar field: backslash, semicolon, comma and line breaks are escaped.
const text = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// A line is at most 75 bytes; a longer one carries on, after a space, on the next.
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// The feed: one event for each court booked, with the gate code in its notes. Times are given
// in UTC, worked out from UK clock time, so they are right on both sides of a clock change.
function feed(results, { now = Date.now(), venue = VENUE, name = 'Tennis courts' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Court Booker//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(name)}`, 'X-WR-TIMEZONE:Europe/London',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',     // a hint; each phone decides how often it looks
  ];
  const booked = Object.values(results || {}).filter(r => r && r.status === 'booked')
    .sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
  for (const r of booked) {
    const date = civilOf(r.date);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${r.id.replace(/[^0-9A-Za-z-]/g, '-')}@court-booker`,
      `DTSTAMP:${stamp(r.at || now)}`,
      `DTSTART:${stamp(londonInstant(date, r.start))}`,
      `DTEND:${stamp(londonInstant(date, r.end))}`,
      `SUMMARY:${text(`Tennis · Court ${r.court}`)}`,
      `LOCATION:${text(venue)}`,
      `DESCRIPTION:${text(r.gate ? `Gate code: ${r.gate}` : 'Gate code: see your ClubSpark booking.')}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// The page the "Add to my calendar" button opens: one link that a phone's calendar understands.
const page = (host, token) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Court Booker calendar</title></head>
<body style="font: 17px/1.45 -apple-system, system-ui, sans-serif; margin: 44px 24px; max-width: 30em; color: #111">
<h1 style="font-size: 22px; margin: 0 0 12px">Court Booker</h1>
<p>Your booked tennis courts as a calendar that keeps itself up to date: court, time and gate code.</p>
<p><a href="webcal://${host}/cal/${token}.ics" style="display: inline-block; padding: 12px 18px; border-radius: 10px; background: #111; color: #fff; text-decoration: none">Add to my calendar</a></p>
<p style="color: #666; font-size: 14px">On an iPhone this opens Calendar and asks to subscribe. In any other calendar, add this address as a subscription:<br>
<code style="word-break: break-all">https://${host}/cal/${token}.ics</code></p>
<p style="color: #666; font-size: 14px">Anyone with this address can see your bookings and gate codes. Keep it to yourself.</p>
</body></html>`;

module.exports = { feed, page, fold, text, stamp, VENUE };
