'use strict';
// The tennis venues the bot knows, for the app (its `venues`) and for anything that names one.
//
// Glasgow Life's seven park venues all book on ClubSpark, at clubspark.lta.org.uk/<address>/Booking,
// in the same way, and the owner's annual pass makes every booking there free. The addresses are
// the ones Glasgow Life's own ClubSpark pages give. Your PC reads and books them (lib/clubspark.js
// here, tools/clubspark-now.js on the PC), which keeps its own copy of this table and only ever
// takes a key from the bot.
//
// Scheduling (the weekly times and one-off dates your PC books at the release, at 22:00 a week
// ahead) is for Kelvingrove only: the nightly run on your PC books the one VENUE in its .env, with
// one court order. Every other park is booked with Book now, on a day that is already open.
//
// Glasgow Club's courts (Gorbals indoor, Scotstoun indoor, and Scotstoun outdoor once its id is
// known) are another site: lib/glasgowclub.js.

const PARKS = [
  { key: 'drumchapel', name: 'Drumchapel Park', address: 'DrumchapelParkTennisCourts' },
  { key: 'garrowhill', name: 'Garrowhill Park', address: 'GarrowhillPark' },
  { key: 'kelvingrove', name: 'Kelvingrove Park', address: 'KelvingroveParkTennisCourts' },
  { key: 'knightswood', name: 'Knightswood Park', address: 'KnightswoodParkTennisCourts' },
  { key: 'maryhill', name: 'Maryhill Park', address: 'MaryhillParkTennisCourts' },
  { key: 'queenspark', name: 'Queens Park', address: 'QueensParkTennisCourtsGlasgow' },
  { key: 'victoriapark', name: 'Victoria Park', address: 'VictoriaParkTennis' },
];
const SCHEDULED = 'kelvingrove';          // the one park the nightly run books at the release
const CLUBSPARK = 'https://clubspark.lta.org.uk';

const parkOf = key => (typeof key === 'string' && PARKS.find(p => p.key === key)) || null;
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
//   { key, name, club: 'clubspark' | 'glasgow', types, centre, schedule, notYet, note, site }
// `types`: the court types that can be read and booked (or held) now. `centre`: the key for
// POST /app/indoor/look and /app/hold (Glasgow Club only, else null). `schedule`: whether the
// weekly times and one-off dates are for this venue. `notYet`: court types the venue has that
// cannot be used yet, with `note` saying so.
function venueList(sheets, todayIso, sheetUrl) {
  const parks = PARKS.map(p => ({
    key: p.key, name: p.name, club: 'clubspark', types: ['outdoor'], centre: null, schedule: p.key === SCHEDULED, notYet: [], note: null,
    site: parkSheet(p, todayIso),
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
      key: first.venue, name: first.name, club: 'glasgow', types: ready.map(s => s.type), centre: ready.length ? ready[0].key : null, schedule: false,
      notYet: waiting.map(s => s.type),
      note: waiting.length ? `${first.name}'s ${waiting.map(s => s.type).join(' and ')} courts are not available yet.` : null,
      site: ready.length ? sheetUrl(ready[0], todayIso) : null,
    };
  });
  return [...parks, ...clubs];
}

module.exports = { PARKS, SCHEDULED, CLUBSPARK, parkOf, parkSheet, parkName, resultId, venueList };
