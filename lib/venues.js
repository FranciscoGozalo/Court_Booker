'use strict';
// The tennis venues the bot knows, for the app (its `venues`) and for anything that names one.
//
// Glasgow Life's seven park venues all book on ClubSpark, at clubspark.lta.org.uk/<address>/Booking,
// in the same way, and the owner's annual pass makes every booking there free. The addresses are
// the ones Glasgow Life's own ClubSpark pages give. Your PC reads and books them (lib/clubspark.js
// here, tools/clubspark-now.js on the PC), which keeps its own copy of this table and only ever
// takes a key from the bot.
//
// Scheduling (weekly times and one-off dates, version 2.10) is for every venue. The parks open a
// day `daysAhead` days ahead at the release (22:00 a week ahead), and your PC's nightly run books
// them then: Kelvingrove first, on its own path and with its court order, as it always has; then
// the other parks, any court free for the whole slot, the lowest-numbered first. Book now (the
// app) books a park on a day that is already open.
//
// Glasgow Club's courts (Gorbals indoor, Scotstoun indoor and Scotstoun outdoor) are another
// site (lib/glasgowclub.js). It opens each day 7 days ahead at 00:00, every booking there is paid
// (your PC pays automatically with the card it keeps, when that is switched on), and none of it
// counts toward Glasgow Life's weekly allowance.

const PARKS = [
  { key: 'drumchapel', name: 'Drumchapel Park', address: 'DrumchapelParkTennisCourts' },
  { key: 'garrowhill', name: 'Garrowhill Park', address: 'GarrowhillPark' },
  { key: 'kelvingrove', name: 'Kelvingrove Park', address: 'KelvingroveParkTennisCourts' },
  { key: 'knightswood', name: 'Knightswood Park', address: 'KnightswoodParkTennisCourts' },
  { key: 'maryhill', name: 'Maryhill Park', address: 'MaryhillParkTennisCourts' },
  { key: 'queenspark', name: 'Queens Park', address: 'QueensParkTennisCourtsGlasgow' },
  { key: 'victoriapark', name: 'Victoria Park', address: 'VictoriaParkTennis' },
];
const SCHEDULED = 'kelvingrove';          // the park the nightly run books first, on its own path (its ids carry no venue)
const CLUBSPARK = 'https://clubspark.lta.org.uk';
// Glasgow Club's venues, with their court types (each type is one of lib/glasgowclub.js's sheets).
const CLUBS = [
  { key: 'gorbals', name: 'Gorbals', types: ['indoor'] },
  { key: 'scotstoun', name: 'Scotstoun', types: ['indoor', 'outdoor'] },
];
const CLUB_DAYS_AHEAD = 7;                // Glasgow Club opens each day this many days ahead...
const CLUB_RELEASE_MIN = 0;               // ...at 00:00 (UK time)

const parkOf = key => (typeof key === 'string' && PARKS.find(p => p.key === key)) || null;
const clubOf = key => (typeof key === 'string' && CLUBS.find(c => c.key === key)) || null;
// Every venue's key, the parks first: the order the app lists them in.
const VENUE_KEYS = [...PARKS.map(p => p.key), ...CLUBS.map(c => c.key)];
const isVenue = key => !!(parkOf(key) || clubOf(key));
// The court types a venue has: a park's are outdoor, Glasgow Club's its own.
const typesOf = key => (parkOf(key) ? ['outdoor'] : clubOf(key) ? clubOf(key).types.slice() : []);
const venueName = key => ((parkOf(key) || clubOf(key) || {}).name || null);
// What a booking's place is called to a person: "Kelvingrove Park", "Gorbals", "Scotstoun outdoor"
// (Scotstoun's indoor courts are plain "Scotstoun", as everywhere else).
const placeName = (venue, type) => (venue === 'scotstoun' && type === 'outdoor' ? 'Scotstoun outdoor' : venueName(venue || SCHEDULED));
// A park's booking sheet for a day, on ClubSpark: the page to book on by hand.
const parkSheet = (park, dateIso) => `${CLUBSPARK}/${park.address}/Booking/BookByDate#?date=${dateIso}`;
// A result's id: the date and start played, as the nightly run's results have always been, with
// the park in front for any park but Kelvingrove ("queenspark/2026-11-24@18:00"). Kelvingrove's
// stay as they were, so that a court booked there with Book now counts for the schedule too.
function resultId(venue, dateIso, start) {
  const hm = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
  return `${venue === SCHEDULED ? '' : `${venue}/`}${dateIso}@${hm}`;
}
// The park a result belongs to, by the name the app and the messages use: "Queens Park".
const parkName = key => (parkOf(key) || parkOf(SCHEDULED)).name;

// Every venue, as the app's state shows it. `sheets` is lib/glasgowclub.js's SHEETS: each Glasgow
// Club tennis sheet with its court type, `activity` null while its id is not known. `todayIso`
// dates the links. The shape is the same for each:
//   { key, name, club: 'clubspark' | 'glasgow', types, centre, schedule, notYet, note, site, centres, sites,
//     release, paid, allowance }
// `types`: the court types that can be read and booked (or held) now. `centre`: the key for
// POST /app/indoor/look and /app/hold of the first of them (Glasgow Club only, else null), and
// `centres` the key for each type ({ indoor: 's', outdoor: 'o' } at Scotstoun; {} at a park).
// `schedule`: whether the weekly times and one-off dates are for this venue (every venue, since
// 2.10). `notYet`: court types the venue has that cannot be used yet, with `note` saying so.
// `site`: the page to book on for the first type, and `sites` that page for each type.
// `release`: when a day opens there: `daysAhead` days ahead, `at` minutes after midnight (UK).
// `paid`: whether a booking there is paid (Glasgow Club's: by your PC, automatically). `allowance`:
// whether it counts toward Glasgow Life's weekly allowance (the parks' do).
function venueList(sheets, todayIso, sheetUrl, { daysAhead = 7, releaseMin = 1320 } = {}) {
  const parks = PARKS.map(p => ({
    key: p.key, name: p.name, club: 'clubspark', types: ['outdoor'], centre: null, schedule: true, notYet: [], note: null,
    site: parkSheet(p, todayIso), centres: {}, sites: { outdoor: parkSheet(p, todayIso) },
    release: { daysAhead, at: releaseMin }, paid: false, allowance: true,
  }));
  const byVenue = new Map();
  for (const s of Object.values(sheets)) {
    if (!byVenue.has(s.venue)) byVenue.set(s.venue, []);
    byVenue.get(s.venue).push(s);
  }
  const clubs = [...byVenue.values()].map(list => {
    const ready = list.filter(s => s.activity), waiting = list.filter(s => !s.activity);
    const first = ready[0] || list[0];
    return {
      key: first.venue, name: first.name, club: 'glasgow', types: ready.map(s => s.type), centre: ready.length ? ready[0].key : null, schedule: true,
      notYet: waiting.map(s => s.type),
      note: waiting.length ? `${first.name}'s ${waiting.map(s => s.type).join(' and ')} courts are not available yet.` : null,
      site: ready.length ? sheetUrl(ready[0], todayIso) : null,
      centres: Object.fromEntries(ready.map(s => [s.type, s.key])),
      sites: Object.fromEntries(ready.map(s => [s.type, sheetUrl(s, todayIso)])),
      release: { daysAhead: CLUB_DAYS_AHEAD, at: CLUB_RELEASE_MIN }, paid: true, allowance: false,
    };
  });
  return [...parks, ...clubs];
}

module.exports = {
  PARKS, CLUBS, SCHEDULED, CLUBSPARK, CLUB_DAYS_AHEAD, CLUB_RELEASE_MIN, VENUE_KEYS,
  parkOf, clubOf, isVenue, typesOf, venueName, placeName, parkSheet, parkName, resultId, venueList,
};
