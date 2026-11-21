# The app's API

What the iPhone app (the Court_Booker_App repository) asks of the bot. It sits on the same small
HTTP server as the PC's endpoint (`lib/server.js`), under `/app/`. Almost everything the app can do,
the owner can already do in Telegram, and each such request is carried out by the function behind
the Telegram command or button of the same name (`app.js`), so the checks and the words are the same.

Two things are the app's alone:

- Paying for a held court with the card your PC keeps (see "Paying from the app"), which only the
  app can ask for, because only the app has the card's security code.
- Glasgow Life's seven parks on ClubSpark, their free courts read and a court booked now
  (`POST /app/clubspark/look` and `/book`; see "The parks on ClubSpark"). So a paired phone can have
  your PC sign in to ClubSpark and book, within these bounds: at most 4 bookings an hour; only a
  court a look showed the app free, from a read in the last 15 minutes; never past the week's
  allowance (7 sessions, 14 hours); never around the nightly run; and never a court that costs
  money: bookings are free with the owner's annual pass, and at any price or payment step your PC
  stops and says so.

Everything else adds no new power.

This file describes the API as built in version 2.11.0 (`api: 3`; 2.11.0 added two courts at once at Glasgow Club, by fields
only: `courts` on `POST /app/hold` and in `hold` (with `courtNames` and `prices`), and `courts` on weekly bookings, one-off
dates and results, and in the signature's words for two courts (see "Two courts at once (2.11)"); and each weekly booking's
and one-off date's signature itself, `weekly[].auth` and `once[].auth`, which an app from 2.11 checks against the card's pay
key instead of signing anything afresh by itself (see "Signed bookings"); 2.10.4 added `ref` to each note, the result it is about, and the
same as `data.ref` on its notification (see "Notes and notifications"); 2.10.3 changed no field's shape: a Glasgow Club court
held and paid for now also shows in `results`, a hold's `pay` order may ask your PC to use the security code it keeps (see
"The sealed box"), and many sentences are shorter: `pc.line`, the hold's `lines`, a look's `note`, and the `why` of many
refusals; 2.10.1 added signed bookings: `auth` on the requests that
save one, `signed` in the state, and `POST /app/weekly/auth`, see "Signed bookings"). `api: 3` adds weekly bookings and one-off dates at every
venue (`state.weekly`, `POST /app/weekly` and its change, on and remove, a `venue` and `type` on `POST /app/once`), Glasgow
Club's courts booked and paid by your PC at midnight (`venues[].release`, `.paid` and `.allowance`; `price` and `paid` on
results), and the switch for automatic payments (`card.auto`, `POST /app/card/auto` and `/off`): see "Weekly bookings at
any venue" below. Everything of `api: 2` is as it was, but for three additions to what was there: `venue` and `type` on
`once`, on `release.jobs` and on results; `schedule` true for every venue; and Kelvingrove's `plan` now derived from the
weekly entries (see `plan`). (2.9.1 added `card.tag`, see `card`; 2.9.3 added Scotstoun's outdoor courts, the centre `"o"`,
with `venues[].centres` and `.sites` and `indoor.centres[].label` and `.type`.) `api: 2` adds the card and Pay
(`pc.cardKey`, `card`, `hold.can.pay`, the hold stages `"paying"` and `"approve"`, `POST /app/card`,
`POST /app/card/forget` and `what: "pay"` in `POST /app/hold/order`), and Glasgow Life's seven parks
on ClubSpark (`POST /app/clubspark/look` and `/book`, `state.clubspark`), with every venue and its
court types (`state.venues`), the weekly allowance (`state.allowance`) and `venue` on each result.
Everything of `api: 1` is as it was, but for two things: the words of a hold in the basket (they no
longer say to pay on the phone: signing in to Glasgow Club on a phone does not show the basket your
PC filled), and the weekly allowance, which can now refuse a one-off date or a weekly time that
would pass it. The pure parts are in `lib/appapi.js`, the parks' in `lib/clubspark.js`,
`lib/venues.js` and `lib/allowance.js`, the push sender in `lib/push.js`, and the checks in
`test/appapi.test.js`, `test/pay.test.js`, `test/clubspark.test.js` and `test/allowance.test.js`.

Bodies are JSON, at most 4 KB. Instants (`at`, `seenAt`, `until`, `opensAt`…) are milliseconds since
1970. `start` and `end` are minutes after midnight, UK time. Dates are `YYYY-MM-DD`, UK calendar dates.
Every sentence the API gives (a `why`, a `line`, a `note`, a hold's `title` and `lines`) is plain
text with no markup, ready to show as it is.

The server only runs where the PC is linked (`AGENT_PUBLIC_KEY` or `AGENT_TOKEN` is set), so that
is also where the app can reach the bot. Answers carry `cache-control: no-store`. There are no
CORS headers: the API is meant for the phone app, not for a page in a browser.

## Who is asking

- `GET /app/hello` and `POST /app/pair` are open. Everything else needs `Authorization: Bearer <token>`,
  the token `/app/pair` gave that phone. Without a good one: `401 { ok: false, why: "unpaired" }`.
  A phone that is unlinked while its `GET /app/state` is waiting gets the same answer.
- The bot keeps only the SHA-256 of each token (`state.apps`), compares in constant time, and notes
  when each phone was last heard from (at most once a minute). At most 5 phones. The tokens are not
  in the one-line `/backup`; without a Railway volume the links are lost when the bot restarts
  (`state.kept` says which it is). No token, code or push token is ever written in the bot's log.
- A phone is linked for one Telegram chat: the bot's owner at that moment. If the bot later
  answers to another chat (`TELEGRAM_CHAT_ID` is set or changed, or the settings file was another
  chat's), a phone linked for the old one is unlinked when the bot starts, with a line in the log.
  `/status` in Telegram says "Phones linked to the app: N" whenever N is not 0.
- The app's door and the PC's are apart: a phone's token opens nothing under `/agent/`, and the
  PC's key or `AGENT_TOKEN` opens nothing under `/app/`. The token is only taken from the
  `Authorization` header, written `Bearer <token>`: not from the address, and not in any other form.
- Pairing: the owner sends `/app` in Telegram and gets a 6-digit code, good for 10 minutes and for
  one use. Five wrong tries cancel it, and a new `/app` replaces it. `/app/pair` takes at most 10
  tries in any 10 minutes at a code that is waiting, whoever they come from (`429 { ok: false, why:
  "slow" }`; tries that are turned away are not counted). A try while no code is waiting is
  answered `none` or `expired` at once and counts for nothing, so asking now and then keeps nobody
  out. Someone who asks without stopping can still see the moment a code is waiting and spend it
  (see "Known limits"). When a phone is linked the bot says so in Telegram. `/app forget` in
  Telegram unlinks every phone and cancels a code that is waiting.

Answers every request can get:

| Status | Body | When |
| --- | --- | --- |
| 401 | `{ ok: false, why: "unpaired" }` | no token, a token the bot does not know, or a phone that has been unlinked |
| 404 | `{ ok: false, why: "no such thing here" }` | a path or method the API does not have (asked by a linked phone; `HEAD` is such a method) |
| 413 | `{ ok: false, why: "That request is too large." }` | a body over 4 KB. One far over it (more than 256 KB) is dropped without any answer: the connection is closed |
| 400 | `{ ok: false, why: "The request body must be JSON." }` | a `POST` from a linked phone whose body is not JSON, whatever the path, one that does not exist included (an empty body counts as `{}`) |
| 400 | `{ ok: false, why: "The request body must be a JSON object." }` | JSON that is not an object, where fields are needed |
| 500 | `{ ok: false, why: "Something went wrong on my side. Try again." }` | a fault in the bot; it is in the bot's log |

A request that does not finish arriving is cut off after about 15 seconds for its headers, or 30
for the whole of it (the connection is closed). That is about sending a request, not about waiting
for the answer: `GET /app/state` may wait its 25 seconds, an indoor look its 20, and a park's look 45.

What the app cannot overdo (each is spelt out where it belongs below): 12 indoor looks that need a
fresh read in any minute, 6 reads of the parks on ClubSpark in any 10 minutes (none from 21:00 to
22:30, and no booking there from 21:25, nor any for 2 hours after ClubSpark turns your PC away), 4
bookings at the parks in an hour, 60 one-off dates on the list, 4 waits open at once for one phone,
a hold or a booking only for a court that a look showed the app free in the last 15 minutes, the
week's 7 sessions and 14 hours, one card on its way to the PC at a time, and one Pay for each hold.

## Reading

`GET /app/hello` → `{ ok: true, bot: "2.11.0", api: 3 }`. Nothing private.

`POST /app/pair { code, name }` → `{ ok: true, token, device: { id, name } }`, or `400 { ok: false,
why: "wrong" | "expired" | "none" | "full", left }` (`left`: tries left on this code).

- `code`: the six digits, as a string (spaces are ignored) or a number. `name`: what to call the
  phone, up to 40 characters (counted as characters, so an emoji is never cut in two); without one
  it is `"iPhone"`.
- `token`: 43 characters (32 random bytes, base64url). It is given this once and never again.
  `device.id`: 8 hex characters.
- `wrong`: not the code that is waiting; `left` counts down 4, 3, 2, 1, 0, and at 0 the code is
  cancelled. Anything that is not the code is a wrong try, a body that cannot be read too.
- `expired`: the code's ten minutes are over (`left: 0`). It stays "expired" until a new `/app`,
  or until the bot restarts: a code is kept in memory only, so after a restart the answer is `none`.
- `none`: no code is waiting: none was asked for, it has been used, it was cancelled, or the bot
  has restarted since (`left: 0`).
- `full`: the code is right, but five phones are linked already. The code is not used up (`left`
  as it stood), so it works once a phone has been unlinked. Only someone with the code is told.
- The same right code sent twice at once links one phone; the other is told `none`.

`POST /app/unpair {}` → `{ ok: true }`: forgets the phone that asked. Its token is then no use.

`GET /app/state?have=<etag>&wait=<0..25>` → `{ ok: true, etag, state }`. With `have` equal to the
current etag the answer waits up to `wait` seconds for a change and then, if there was none, is
`{ ok: true, etag, same: true }`. The etag is a hash of the state without `now` (40 hex characters).

- Without `have`, or with one that is not the current etag, the state comes at once.
- `wait` may be a fraction; it is cut to 25. While it waits the bot looks about once a second, so
  a change is at most a second old when it arrives. Changes that only the clock brings (the PC
  falling silent, a day opening, midnight) end the wait like any other.
- One phone may have four waits open at once. A fifth is not kept waiting: it is answered at once
  with `{ ok: true, etag, state }`, though the state is the one it has.
- Each phone has its own etag, because `devices[].me` differs.
- Two things in the state move by themselves, and each ends a wait: `pc.seenAt`, every time the PC
  is heard from (about once a minute while it is awake, every few seconds while it holds a court),
  and `devices[].seenAt`, at most once a minute for each phone that is asking. So a wait seldom
  lasts its full length while the PC is awake.

```
state = {
  now, bot: "2.11.0",
  venue: { name: "Kelvingrove Park", short: "KP", first: 540, last: 1260, lengths: [1, 2],
           courts: [1,2,3,4,5,6], releaseMin: 1320, daysAhead: 7, maxAheadDays: 90 },
  venues: [ { key, name, club: "clubspark" | "glasgow", types: ["outdoor"] | ["indoor"] | ["indoor", "outdoor"],
              centre, schedule, notYet: [ … ], note, site,
              centres: { indoor?: "g" | "s", outdoor?: "o" }, sites: { indoor?, outdoor? },
              release: { daysAhead: 7, at }, paid, allowance } ],                // every venue, in a fixed order
  clubspark: { linked, days: { first, last }, quietUntil, lookNo, bookNo,  // the parks on ClubSpark
               reads: { used, max: 6, nextAt }, book: null | book },
  allowance: [ { week, sessions, hours, plannedSessions, plannedHours, maxSessions: 7, maxHours: 14 } ],   // this week, then next
  paused: false,
  kept: "disk" | "variable" | "no",
  pc: { state: "awake" | "asleep" | "offline", linked, seenAt, line,      // line: the menu's own line about the PC, plain text
        canWake, wakeWhy, canSleep, sleepWhy, sleepAsked, wokeAt,
        cardKey },                                                      // the PC's key for sealing a card (base64), or null
  release: null | { at, night, jobs: [ { id, venue, type, date, start, end, from: "weekly" | "once" } ] },   // the next release that books something
  later:   [ the same, for the releases after it (up to 3) ],
  open:    [ { id, date, start, end } ],             // one-off dates already open, which the PC books at its next run
  plan:    [ { day: "mon".."sun", start, hours } ],  // Kelvingrove's weekly bookings, one a day (api 2's view of weekly)
  weekly:  [ { id, venue, type, day, start, hours, end, on, next, signed, courts, auth } ],     // weekly bookings at every venue (api 3); courts (2.11): 1 or 2; auth (2.11): the signature, or null
  once:    [ { id, venue, type, date, start, hours, end, opensAt, open, signed, courts, auth } ],   // one-off dates still ahead, at every venue
  order:   [3, 6, 1, 2, 4, 5],
  results: [ { id, venue, status: "booked" | "none" | "failed", date, start, end, court, gate, why, at, past, type, price, paid, courts } ],   // soonest upcoming first, then past ones newest first
  run:     null | { stage: "started" | "ready" | "trouble", at, why },    // tonight's run, as the PC reports it
  indoor:  { linked, days: 9, quietUntil, holdNo,                         // holdNo: why no hold can start now (plain text), or null
             centres: [ { key: "g", name: "Gorbals", site, label: "Gorbals", type: "indoor" },
                        { key: "s", name: "Scotstoun", site, label: "Scotstoun", type: "indoor" },
                        { key: "o", name: "Scotstoun", site, label: "Scotstoun outdoor", type: "outdoor" } ] },
  card:    null | { brand, last4, expMonth, expYear, tag, pending, forgetting, why, auto, autoAsked, autoWhy },   // the card your PC keeps, for Pay and automatic payments
  hold:    null | hold,
  notes:   [ { id, at, kind: "booked" | "missed" | "warn" | "hold" | "info", title, body, ref } ],   // newest first, the last 30; ref (2.10.4): the result it is about, or null
  devices: [ { id, name, at, seenAt, me } ],
}

hold = { id, startedBy: "app" | "telegram", centre, centreName, date, start, end, court, courtName,
         courts: [3] | [3, 4], courtNames: ["Court 3", …],                  // 2.11: every court held; court and courtName the first
         stage, live, ended: null | "released" | "booked" | …, price, prices, until, heardAt,   // price: the total; prices (2.11): each court's, or null
         title, lines: [ … ],                // the Telegram card's own words, without markup
         can: { release, done, pay },
         links: { basket, site, sheet } }

book = { id, venue, venueName, date, start, end, hours, court, courtName,       // Book now at a park
         stage: "asked" | "starting" | "signing-in" | "signed-in" | "booking", live,
         ended: null | "booked" | "gone" | "failed" | …, why, gate, at, heardAt, line }
```

### The state, field by field

**`now`**: the bot's clock. **`bot`**: its version.

**`venue`**: Kelvingrove's fixed facts. `first` and `last` are the earliest start and the latest end
that Telegram's buttons offer (09:00 and 21:00); `lengths` the hours a booking can last; `releaseMin`
when a day opens (22:00 unless `RELEASE_TIME` says otherwise) and `daysAhead` how many days before
(7 unless `DAYS_AHEAD` does); `maxAheadDays` how far ahead a one-off may be (90). These are
Kelvingrove's; when each venue opens its days is `venues[].release` (api 3).

**`venues`**: every venue the bot knows, always in this order, with the same fields for each:

| `key` | `name` | `club` | `types` | `centre` | `schedule` |
| --- | --- | --- | --- | --- | --- |
| `drumchapel` | Drumchapel Park | `clubspark` | `["outdoor"]` | null | true |
| `garrowhill` | Garrowhill Park | `clubspark` | `["outdoor"]` | null | true |
| `kelvingrove` | Kelvingrove Park | `clubspark` | `["outdoor"]` | null | true |
| `knightswood` | Knightswood Park | `clubspark` | `["outdoor"]` | null | true |
| `maryhill` | Maryhill Park | `clubspark` | `["outdoor"]` | null | true |
| `queenspark` | Queens Park | `clubspark` | `["outdoor"]` | null | true |
| `victoriapark` | Victoria Park | `clubspark` | `["outdoor"]` | null | true |
| `gorbals` | Gorbals | `glasgow` | `["indoor"]` | `"g"` | true |
| `scotstoun` | Scotstoun | `glasgow` | `["indoor", "outdoor"]` | `"s"` | true |

- `club`: `clubspark` is Glasgow Life's parks, read and booked with `POST /app/clubspark/look` and
  `/book` (`key` is the `venue` they take); `glasgow` is Glasgow Club, read and held with
  `POST /app/indoor/look` and `/app/hold` (`centre` is the `centre` they take).
- `types`: the court types that can be read and booked (or held) now. `notYet`: court types the
  venue has that cannot be used yet, and `note` says so, else null (since 2.9.3 every venue has
  `notYet: []` and `note: null`). Scotstoun has outdoor courts too, booked on Glasgow Club's site as
  a sheet of their own (activity SA008 in the group AG153; courts "Outdoor Tennis Court 1", …,
  hourly from 08:00 to 18:00, a week ahead like the indoor ones): `types: ["indoor", "outdoor"]`.
- `centres` (2.9.3): the `centre` for each type, for `POST /app/indoor/look` and `/app/hold`:
  Gorbals `{ indoor: "g" }`, Scotstoun `{ indoor: "s", outdoor: "o" }`, a park `{}`. `centre`
  stays the first of them (`"s"` at Scotstoun), as before.
- `sites` (2.9.3): `site` for each type: the park's ClubSpark sheet (`{ outdoor }`), or each of
  the centre's Glasgow Club sheets for today. Scotstoun, on 20 Nov 2026:
  `{ indoor: "https://glasgowclub.gladstonego.cloud/book/calendar/SA011?activityDate=2026-11-20T00:00:00.000Z",
  outdoor: "https://glasgowclub.gladstonego.cloud/book/calendar/SA008?activityDate=2026-11-20T00:00:00.000Z" }`.
- A centre is read and held by your PC: one whose booker is not yet updated for Scotstoun's outdoor
  courts answers a look at `"o"` with "no such centre or day", and the look ends with that (see
  `POST /app/indoor/look`). Update the PC before the bot.
- `schedule`: whether weekly bookings and one-off dates (`weekly`, `once`) can be at this venue: every
  venue since 2.10 (`api: 3`; before it, Kelvingrove alone). Book now (the parks) is for a day already open.
- `release` (api 3): when a day opens there: `daysAhead` days ahead, at `at` minutes after midnight (UK):
  the parks `{ daysAhead: 7, at: 1320 }` (`releaseMin`), Glasgow Club `{ daysAhead: 7, at: 0 }`.
- `paid` (api 3): whether a booking there is paid: false at the parks (the pass), true at Glasgow Club
  (your PC pays automatically, when `card.auto`). `allowance` (api 3): whether it counts toward the
  weekly allowance: true at the parks, false at Glasgow Club.
- `site`: the page to book on by hand: the park's ClubSpark booking sheet for today, or the
  centre's Glasgow Club sheet for today.

**`clubspark`**: the parks on ClubSpark, all seven together, as `POST /app/clubspark/look` and
`/book` stand now.

- `linked`: as `pc.linked`. `days`: the days that can be read and booked now, `first` (today) to
  `last` (a week ahead once tonight's release has passed, else six days ahead), as YYYY-MM-DD.
- `quietUntil`: until when nothing is read or booked at ClubSpark from the app, after ClubSpark
  turned your PC away (two hours); otherwise null. "Turned away", as your PC counts it: ClubSpark's
  "Just a moment" check, and also a booking page or sheet that never shows, or a request answered 403,
  which is how a check can look. A ClubSpark your PC cannot reach at all (it is offline) does not count.
- `lookNo`: the sentence a look that needs a fresh read would be refused with now, or null. A look
  may still be answered from a recent read (see the request). `bookNo`: the same for Book now,
  for the reasons that do not depend on the court, the day or the week; null when it can start.
- `reads`: fresh reads asked of your PC in the last ten minutes (`used`, of `max` 6), and `nextAt`,
  when the next can be asked, while all six are used; otherwise null.
- `book`: the booking being followed, or the last one, kept in memory only (null after a restart):
  - `id`: 12 hex characters. `venue`, `venueName`: the park. `date`, `start`, `end`, `hours`:
    the time booked. `court`: its number; `courtName`: "Court 3".
  - `stage`: `"asked"` → `"starting"` (your PC is opening ClubSpark) → `"signing-in"` → `"signed-in"`
    → `"booking"` (it had this bot's go-ahead and is pressing "Continue booking"). It only moves
    forwards and stays where it was when the booking ends.
  - `live`: true while under way; the same as `ended === null`.
  - `ended`: `"booked"`; `"gone"` (the court was no longer free for that time, and no other was
    taken); `"failed"` (your PC's reason is in `why`); `"refused"` (your PC did not start it);
    `"quit"` (your PC's tool stopped without a word); and five this bot decides itself, which your
    PC's own word still replaces if it comes: `"notsent"` (the quiet time came round before your PC
    collected it), `"nopickup"` (not collected within 25 seconds), `"nostart"` (collected, then no
    step for 90 seconds), `"silent"` (no word for four minutes) and `"timeout"` (still at it twelve
    minutes after it was collected, beats or not). A `"booked"` from your PC replaces any ending at
    all, its own `"failed"` too: a booking stands. Its word about any of the last ten bookings counts,
    even one a newer booking has replaced.
  - `why`: null while under way and when booked; otherwise the result's reason (the words after
    "It didn’t work: " in `results`). `gate`: the gate code, when booked and shown, else null.
  - `at`: when it was asked for. `heardAt`: when your PC last said anything about it.
  - `line`: one plain sentence for the moment: "Asking your PC to book it." / "Starting Chrome on
    your PC…" / "Opening ClubSpark…" / "Signing in to ClubSpark…" /
    "Signed in. Looking for court 3 on the sheet…" / "Booking court 3…" / "No word from your PC for
    over a minute." / "Booked: court 3. Gate code 4821." (or "… Gate code not shown.") /
    "Not booked: <why>."

**`allowance`**: Glasgow Life Tennis's weekly allowance, this week and then next: at most 7
sessions and 14 hours in a week, across the seven parks. A week is taken to run Monday to Sunday
(UK), and a session counts in the week of the day it is played. That is an assumption: the rules
as the owner gave them do not say. `week`: that Monday, YYYY-MM-DD.

- `sessions`, `hours`: what is booked in that week: every result with status `booked`, at any of
  the parks (Book now, or your PC's nightly run), cancelled or not. A session changed or cancelled
  still counts, and the bot never hears of a cancellation, so every booking it made counts.
  (Results are kept 60 days, which covers any week this can be about.)
- `plannedSessions`, `plannedHours`: what the schedule still asks for in that week and has not
  booked: a weekly time until ten minutes after its release, a one-off date until it starts.
- `maxSessions`, `maxHours`: 7 and 14.
- The guards: Book now is refused when what is booked in its week, and it, would pass a limit;
  adding a one-off date or a weekly time (Telegram, its buttons and the app alike) is refused when
  what is booked and planned would pass a limit in a week the change adds to; and your PC's
  nightly run is not handed a job that would pass one, counting the jobs handed out before it.
  That job gets a result (`failed`) saying why, with a card in Telegram and a note.
- Glasgow Club's indoor courts are not counted: they are another organisation's.

**`paused`**: true after `/pause`. While it is true nothing is booked, so `release` is null and
`later` and `open` are empty; `plan` and `once` still list what is asked for.

**`kept`**: whether settings outlast a restart: `"disk"` (yes), `"variable"` (yes, from the
`COURT_SETTINGS` variable, though not the linked phones) or `"no"`.

**`pc`**

- `state`: `"awake"` (heard from in the last 3 minutes), `"asleep"`, or `"offline"` (not for over a
  day, or never). `linked`: whether a PC can reach the bot at all (always true over HTTP).
  `seenAt`: when it was last heard from, or null.
- `line` (2.10.3: short, as the app shows it beside the PC): one of "Awake" / "Asleep · wakes at 21:55" /
  "Last seen yesterday at 21:55" (or "… today at 13:01", "… Mon 16 Nov at 21:55") / "Not in touch yet"
  (null if no PC is linked). Telegram's menu says "Your PC · " before it.
- `canWake`, `wakeWhy`: whether `POST /app/pc/wake` would send a wake-up now, and if not, the
  sentence it would be refused with (null when it can): "Waking is not set up: add WAKE_MAC on
  Railway." / "Can’t wake your PC: it hasn’t been in touch." / "Already awake." / "Sent a moment ago. Give it a minute." (for 30 seconds after a wake-up).
- `canSleep`, `sleepWhy`: the same for `POST /app/pc/sleep`: "Your PC isn’t linked." / "Already
  asleep." / "Your PC isn’t answering." (offline) / "Staying awake for the 22:00 booking." (from 30
  minutes before a release; "… the 00:00 booking." around Glasgow Club's midnight) / "Your PC is
  holding a court. Let it go first." / "Your PC is booking a court. Wait for it to finish." (Book now
  at a park, under way)
- `sleepAsked`: when sleep was asked for, while the PC has not collected the request yet (it has
  two minutes to; after that, or once collected, null). `wokeAt`: when the last wake-up was sent
  since the bot started, or null.
- `cardKey`: your PC's key for sealing a card or a security code to it: standard base64 (44
  characters) of a 32-byte X25519 public key, made once on the PC, whose secret half never leaves
  it. As the PC's last ping gave it; null until a ping has, since the bot started (a PC whose
  booker is older than 2.9 never does). See "Paying from the app".

**`release`**: the next release that books something, or null (nothing asked for, or paused).
`at`: the moment it opens. `night`: the date of that night. `jobs`: what it books, by start time;
`id` is `YYYY-MM-DD@HH:MM` (the date and start played) for Kelvingrove, and the venue in front of it
for any other (`queenspark/2026-11-25@19:00`, `gorbals/2026-11-25@18:00`), the same id a result
carries; `venue` and `type` (api 3) say where; `from` says whether it comes from a weekly entry or a
one-off (`"weekly"` when both ask for the same venue and slot). The parks' release is at
`releaseMin`, `daysAhead` days ahead; Glasgow Club's is its own entry, at 00:00, 7 days ahead (the
release of the night before: `night` is that evening's date, `at` the midnight after it).
A release stays here until ten minutes after `at`, as the bot's own "Next booking" does.

**`later`**: up to three releases after that one, in the same shape.

**`open`**: one-off dates whose day is already open and which are not booked yet: the PC books them
at its next run. A one-off that repeats a weekly slot whose release was missed is one of these.
(In the ten minutes after a release, a one-off it opened is both here and still in `release.jobs`.)

**`plan`**: Kelvingrove's weekly bookings that are on, Monday first, one a day (the earliest when
there are several): what `api: 2` called the weekly plan, and what `/set`, `/off` and the weekly
buttons in Telegram show and change. `weekly` has them all. **`order`**: the courts in the order
they are tried, at Kelvingrove.

**`weekly`** (api 3): every weekly booking, at every venue, Monday first, then by start, then by venue.
`id`: 8 hex characters, for as long as the entry lasts (Kelvingrove's plan of old became entries with
ids made from its day and start, the same each time). `venue`: a `venues` key. `type`: `"indoor"` or
`"outdoor"` (Scotstoun has both). `day`: `"mon"` to `"sun"`. `hours`: 1 or 2 (always 1 at Glasgow
Club). `end`: `start` plus the hours. `on`: an entry switched off is kept, and never booked.
`next`: `{ date, opensAt }`, the date it is booked for next and when that day opens (ms), or null
when it is off. One venue, day and start once; several entries on a day are fine. The parks' count
toward the weekly allowance; Glasgow Club's do not. `signed` (2.10.1): whether the bot keeps the
app's signature for it (see "Signed bookings"); kept as it was, for apps before 2.11. `auth` (2.11):
that signature itself, the 32 lowercase hex characters as the app sent them, or null when it has
none: an app from 2.11 checks it against the card's pay key itself, and re-signs nothing by itself.
`courts` (2.11): how many courts it books at once, 1, or 2 at Glasgow Club (always 1 at the parks);
see "Two courts at once (2.11)".

**`once`**: the one-off dates whose start is still ahead (one that has started is left out, though
the bot keeps it until midnight), at every venue (api 3), by date, start and venue. `id` as above;
`venue` and `type` as in `weekly` (`"kelvingrove"`, `"outdoor"` for Kelvingrove's); `end` is `start`
plus the hours; `opensAt` is when that day opens for booking at that venue; `open` is whether it has.
`signed` (2.10.1), `auth` (2.11) and `courts` (2.11) as in `weekly`.

**`results`**: what the PC reported, kept for 60 days. First those dated today or later, soonest
first; then the past ones, newest first. `past`: the date is before today (UK).
`venue`: the park, a `venues` key. A result of the nightly run, or of Book now at Kelvingrove, has
`venue: "kelvingrove"` and its id is `YYYY-MM-DD@HH:MM` as it always was, so a Kelvingrove slot
booked with Book now is not booked again by the nightly run. A booking at another park has the
park in front of its id: `queenspark/2026-11-20@18:00`. Its card in Telegram, and its note, name
the park.
`court`: the court as the PC gave it, a short string such as `"3"` (null unless booked).
`type` (api 3): `"indoor"` or `"outdoor"`. `price` and `paid` (api 3), for Glasgow Club's only (null
for the parks'): `price` the price asked for the court (`"£23.00"`, or null when none was read);
`paid` true (paid with the card your PC keeps), false (nothing was paid) or `"maybe"` (Pay was
pressed, and whether the payment went through is not known: look in the banking app and under
Bookings on Glasgow Club's site). The `why` of one not booked ends with what was paid, in words.
`gate`: the gate code, a string (null if not booked, or if none was shown). `why`: null when
booked; "No court free for the whole time." for `none`; "It didn’t work: <the PC's reason>."
for `failed`. `at`: when the result came in.
`courts` (2.11): the courts' numbers when the result names them, else null. Two courts at once at
Glasgow Club are one result for the slot: `courts: [3, 4]` (lowest first), `court: "3 & 4"` (which an
app older than 2.11 shows as it is), `price` the total paid for both (`"£46.00"`). A result of one
court that names it in a list keeps that too (`courts: [3]`, `court: "3"`); one that does not, or a
park's, has `courts: null`. A result that is not booked has none: its `why` says what happened ("It
didn’t work: Only 1 of 2 courts was free, so none was taken. Nothing was paid.", in your PC's words).
Its card in Telegram reads "Booked · Courts 3 & 4", and its note "Courts 3 & 4 booked".
A Glasgow Club court held and then booked (2.10.3: paid from the app, by the PC with its card, or
in Chrome on the PC and then "I have paid") is a result too, as the midnight run's would be for the
same venue, date and start, and under the same id (`scotstoun/2026-11-25@18:00`): `venue`
(`"gorbals"` or `"scotstoun"`, from the hold's centre `g`, `s` or `o`), `type` (`"indoor"`, or
`"outdoor"` for `o`), `court` (`"1"`), `price` (the price your PC read, or null), `paid: true`,
`gate: null`, `status: "booked"`, `why: null`, and `end` an hour after `start`. So the schedule does
not book that slot again, a later result for it does not count twice, and like every Glasgow Club
booking it counts toward no allowance. No card, note or notification comes with it: the hold's own
(`"Booked · Scotstoun outdoor court 1"`) has said so. A booking already kept for that id stands; a
"not booked" one is replaced. A hold that ends any other way keeps no result.
A hold of two courts (2.11) is one result too, under the same id: `court: "3 & 4"`, `courts: [3, 4]`,
`price` the total your PC read at the basket, `paid: true` (its note: `"Booked · Gorbals courts 3 & 4"`).
The courts are the ones your PC's "booked" note names (its `courts`, or its `court` alone from a PC
whose booker is older); a hold of one court is kept as before 2.11, with `courts: null`.

**`run`**: how the PC's booking run stands, from half an hour before a release to an hour after
it. Null outside that time (a run started earlier in the day is not tonight's), while paused, once
every booking of that release has been reported on, and after a restart of the bot until the PC
says more. `stage`: `"started"` (it asked what to
book), `"ready"` (signed in to ClubSpark, waiting for the release) or `"trouble"` (an attempt
failed and it is trying again). `at`: when it said so. `why`: null, or for trouble the two lines of
Telegram's message, such as "ClubSpark did not load. Trying again (2 of 3)."

**`indoor`**

- `linked`: as `pc.linked`. `days`: how many days are on offer, today included (9).
- `quietUntil`: until when the PC leaves Glasgow Club's site alone (an hour), after it met a
  "checking your browser" page there or was told it asks too often; otherwise null.
- `holdNo`: the sentence `POST /app/hold` would be refused with now, or null when a hold can
  start. The sentences are listed under that request.
- `centres[].site`: a web address: that centre's booking sheet on Glasgow Club's own site, for
  today. (For another day use `look.sheet`, or change the date in `activityDate=`.)
- `centres[].name`: the centre ("Scotstoun" for both of Scotstoun's sheets); `centres[].label`
  (2.9.3): what the sheet is called to a person, so that Scotstoun's two can be told apart
  ("Gorbals", "Scotstoun", "Scotstoun outdoor"); `centres[].type` (2.9.3): `"indoor"` or `"outdoor"`.

**`card`**: the card your PC keeps for paying from the app, as the PC's pings say (the bot keeps
none of it across a restart: the PC's next ping, within a minute while it is awake, says it again).
Null when the PC keeps no card as far as the bot knows, none is on its way and there is nothing to say.

- `brand`: "Visa", "Mastercard", "American Express", "Maestro", "Discover", "Diners Club", "JCB"
  or "Card". `last4`: the last four digits, a string. `expMonth` (1 to 12) and `expYear` (four
  digits). All four are null while the PC keeps no card (`pending` or `why` is then what there is).
  Nothing more of the card ever reaches the bot.
- `tag` (added in 2.9.1, within `api: 2`): which pay key the card was kept with, so that the app can
  tell its own card from one given on another phone (or one whose "kept" it never heard): the first
  8 hex characters (lower case) of the SHA-256 of the pay key's 32 raw bytes (the base64 the app
  sealed with the card, decoded). For the pay key of 32 bytes of 0x5a
  (`WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo=`) it is `"60bf07c4"`. Null when the PC keeps
  no card, or its booker is older than 2.9.1 (or the card was kept before it), or what the PC
  said is not 8 such characters. It says nothing of the card or the key that could be used.
- `auto` (api 3): whether your PC keeps the card's security code for automatic payments, as its last
  ping said (see "Weekly bookings at any venue"). `autoAsked`: `"on"` or `"off"` while a
  `POST /app/card/auto` or `/off` waits for the PC (its next ping, within seconds while it is awake;
  an "on" two minutes at most), else null. `autoWhy`: why the last one did not go through, in words
  ("Your PC did not turn automatic payments on: <the PC's reason>.", or that the PC did not collect
  it, or did not answer), else null. A new card, or the card forgotten, deletes the code on the PC:
  `auto` is then false.
- `pending`: true from `POST /app/card` until the PC has said how that card went (it collects it
  with its next ping, within seconds while it is awake, and answers on the ping after), or two
  minutes have gone. The card shown meanwhile is the one kept before.
- `forgetting`: true from `POST /app/card/forget` until the PC has said how that went.
- `why`: why the last card (or forget) did not go through, or null. One of:
  - "Your PC did not keep that card: <the PC's reason>." The PC's reasons: "the card number does
    not pass the check every card number passes (a digit may be wrong)", "the card number should be
    12 to 19 digits", "the card number is missing", "the expiry month should be 1 to 12", "the
    expiry year should be four digits", "the card has expired", "the expiry is more than 20 years
    away, which I take for a slip", "the name on the card should be at most 60 characters", "it came
    without the app's pay key, so no payment could ever be ordered with it", "it
    could not be opened with this PC's key (it was sealed for another key, or changed on the way)",
    "it is not a sealed box (it does not read as base64)", "it is too short to be a sealed box",
    "it is longer than a sealed box may be (1024 characters)", "Windows would not protect it, so it
    was not kept".
  - "Your PC could not forget its card: <the PC's reason>."
  - "Your PC did not collect the card within two minutes, so I dropped it. Send it again while your PC is awake."
  - "Your PC took the card but did not say whether it kept it. The card shown here is the one your PC says it keeps."
  - "Your PC took the order to forget its card but did not say how that went. The card shown here is the one your PC says it keeps."

  It stays until the next `POST /app/card` or `/app/card/forget`, or until the bot restarts.

**`hold`**: the hold being followed, or the last one. It stays after it has ended, with how it
ended, until another is started or the bot restarts (it is kept in memory only). One hold at a
time, whoever started it.

- `id`: 12 hex characters. `startedBy`: `"app"` or `"telegram"`. A hold started from the app has no
  card in Telegram unless a Hold button is tapped there while it is going; then that card follows it.
- `centre`: `"g"`, `"s"` or `"o"`; `centreName`: the centre's `label` ("Gorbals", "Scotstoun" or "Scotstoun outdoor"). `date`, `start`, `end`: the
  hour held (`end` is `start` + 60). `court`: its number; `courtName`: "Court 3".
- `courts` (2.11): every court of the hold, lowest first: `[3]`, or `[3, 4]` for two at once (asked
  for with `POST /app/hold`; Telegram's Hold button holds one). `courtNames`: "Court 3", "Court 4", in
  the same order. `court` and `courtName` stay the first of them, for an app older than 2.11. A hold
  of two is one hold: one at a time, both into the one basket, one payment, and it ends as one.
- `stage`: how far it has got: `"asked"` → `"signing-in"` → `"signed-in"` → `"adding"` → `"held"`
  (in the basket) → `"paying"` (your PC took up Pay from the app: it is typing in the card and
  pressing Pay, or waiting for the answer) → `"approve"` (your bank wants you to approve the
  payment in your banking app; your PC waits up to five minutes). It only moves forwards, with one
  exception: `"paying"` goes back to `"held"` when the PC stops before it has pressed Pay (nothing
  was paid, and the court is in the basket as before). It stays where it was when the hold ends.
- `live`: true while it is under way; the same as `ended === null`.
- `ended`: null while under way, else how it ended:
  `"released"` (let go: asked for, or its time was up), `"booked"` (the PC saw it on the Bookings
  page), `"left"` (the payment page moved on, and the booking was not seen), `"unsure"` (you said
  you paid, and the booking was not seen), `"failed"`, `"refused"` (the PC did not start on it),
  `"closed"` (the Chrome window was closed), `"slept"` (the PC went to sleep), `"gone"` (the PC's
  tool stopped without a word), and four the bot decides itself: `"stopped"` (stopped before the
  PC collected it), `"nopickup"` (the PC did not collect it within 25 seconds), `"nostart"`
  (collected, then nothing for 90 seconds) and `"timeout"` (nothing more heard). After `timeout` or
  `nostart` the PC's own word may still replace it later.
- `price`: such as `"£23.00"` (or `"£23"`), once it is in the basket: the amount on the payment
  page's Pay button as the PC read it. Null before, or if it did not read as a price. For two courts
  (2.11) it is the total for both (`"£46.00"`), and Pay is for that. `prices` (2.11): each court's
  price as your PC read it at the basket, in the order of `courts` (`["£23.00", "£23.00"]`); null
  until it is in the basket, from a PC that gives none (one older than 2.11), or when they do not add
  up to `price`. `until`: when
  the PC lets it go unpaid; null before it is in the basket. While it pays, `until` is when the PC
  stops waiting for the payment's answer (it moves on the PC's word: up to six minutes after the
  press, five after your bank asks for approval).
  `heardAt`: when the PC last said anything about it (at first, when it was asked for).
- `title`: such as "Gorbals · Fri 20 Nov · 18:00–19:00 · Court 3", or "… · Courts 3 & 4" for two
  (2.11). `lines`: what the card says under it, one sentence or more per line, in the words of
  Telegram's card for that moment. For two courts they are the same but for "Putting courts 3 & 4 in
  your basket…", and "I could not see both courts as new bookings on your Bookings page" in place of
  "the court as a new booking" (`"left"`, `"unsure"`: your PC calls them booked only when it sees both).
- `can.release`: Telegram would show Stop or Let it go. `can.done`: it would show I have paid
  (only once the court is in the basket). Both are false once one has been asked, once Pay has been
  asked for (while the order is on its way and while the PC pays), and once it is over.
- `can.pay`: `POST /app/hold/order` with `what: "pay"` and the right amount would be taken now:
  the same check, so it is false exactly when that request would be refused (but for the amount),
  and the refusal's sentence says why. Telegram has no Pay button. For two courts (2.11) it is also
  false until your PC's note from the basket names both (its `courts`): a PC whose booker is older
  than 2.11 holds the first court alone, and says only that one. The lines then say "Can’t pay here:
  your PC didn’t say both courts are in your basket."
- `lines` while paying (the card's words, as they stand):
  - in the basket (2.10.3: the app's own words, which differ from Telegram's only in where to pay):
    "£23.00 to pay. In your basket since 12:00." then, the PC able to pay, "Pay here, or in Chrome on
    your PC and tap I Have Paid." and "Let go at 12:12 if unpaid." (Telegram's card: "Pay in the app,
    or in Chrome on your PC and tap I have paid."). When it cannot: "Can’t pay here: <the PC's
    reason>." then "Pay in Chrome on your PC and tap I Have Paid." A PC with an older booker says
    nothing of paying, and only that second line is there.
  - Pay asked for: "£23.00 to pay." and "Telling your PC to pay £23.00…"; told, and no word from the PC for half a minute: "Your PC was told to pay and has
    not said how it went. Before you pay any other way, look at the Chrome window on your PC, under
    Bookings on Glasgow Club's site and in your banking app."
  - `"paying"`: "Paying £23.00 with the card your PC keeps…"; once
    pressed: "Your PC pressed Pay £23.00; I heard so at 12:03. If your bank asks you to approve it,
    do that in your banking app." and "Waiting for Glasgow Club's answer…"; or, when Chrome gave the
    PC no answer to the press: "Your PC may have pressed Pay £23.00: <why>. I heard so at 12:03."
    and what to do then. What the payment page says after the press may follow: "The payment page
    says: “…”".
  - `"approve"`: "Approve the payment in your banking app. Your bank wants you to approve £23.00 to
    Glasgow Club before it pays." and "Your PC pressed Pay and is waiting for the answer until 12:09."
  - back in the basket after Pay: "Your PC could not pay: <the PC's reason>. Your PC pressed
    nothing." (it does not try again for this court; whether anything was paid in that window by
    other hands, it cannot say: one of its reasons is "someone is already paying in the Chrome window
    on your PC"), or "Not paid from the app: <why>. Your PC pressed nothing, so you can ask again
    there." (the order never reached the PC).
  - how it ended after a press (`ended` as before): "Booked and paid. Now on your Glasgow Club
    Bookings page." (said only on your PC's word that it is there now, and was not before); "Your PC pressed Pay,
    but the payment did not go through: …" (with what the payment page said); "Your PC pressed
    Pay, and then your bank asked for a code to be typed into the payment page. Your PC never types
    or passes on such a code, so it stopped there, and the payment may not have gone through." (`"failed"`);
    "Your PC pressed Pay and your bank asked you to approve the payment, but no approval had come
    when your PC stopped waiting, and I could not see the court as a new booking on your Bookings
    page." (`"unsure"`); and for every ending that cannot know how the payment went (the Chrome
    window closed, the PC asleep, its tool gone, nothing more heard): that Pay was pressed (or may
    have been, or was ordered and never answered for), that whether the payment went through is not
    known here, and to look under Bookings on Glasgow Club's site and in the banking app. After a
    press nothing is ever taken out of the basket, and the PC is never told to let the court go.
- `links.basket`: the basket on Glasgow Club's site (kept for `api: 1`; of no use on a phone, whose
  basket is not the one your PC filled). `links.site`: the site's front page.
  `links.sheet`: that centre's sheet for the hold's date.

**`notes`**: see the last section. **`devices`**: the linked phones. `at`: when each was linked;
`seenAt`: when it was last heard from (to the minute); `me`: the phone that asked.

## Asking

Each answers `{ ok: true, etag, state }` (the state after the change, so the app can redraw at
once), or `400`/`409 { ok: false, why }` with a plain sentence the app can show as it is.
`400`: the request itself is wrong, or asks for something that is not on offer. `409`: the request
is fine, and things as they stand refuse it (the same request may work later).

| Request | The same as | Body |
| --- | --- | --- |
| `POST /app/once` | `/book` | `{ venue?, type?, date, start, hours, courts?, auth? }`; `already: true` in the answer if it was there |
| `POST /app/once/remove` | `/cancel` | `{ date, start }` |
| `POST /app/plan` | `/set` | `{ day, start, hours }` (Kelvingrove's) |
| `POST /app/plan/remove` | `/off` | `{ day }` (Kelvingrove's) |
| `POST /app/weekly` | (app only, api 3) | `{ venue, type, day, start, hours, on, courts?, auth? }`: a weekly booking at any venue |
| `POST /app/weekly/change` | (app only, api 3) | `{ id, venue?, type?, day?, start?, hours?, courts?, auth? }` |
| `POST /app/weekly/on` | (app only, api 3) | `{ id, on }` |
| `POST /app/weekly/remove` | (app only, api 3) | `{ id }` |
| `POST /app/weekly/auth` | (app only, 2.10.1) | `{ items: [{ id, auth }] }`: signatures made afresh, for weekly bookings and one-off dates |
| `POST /app/order` | `/order` | `{ order: [six courts, each once] }` |
| `POST /app/pause` | `/pause`, `/resume` | `{ paused }` |
| `POST /app/pc/sleep` | Sleep my PC | `{}` |
| `POST /app/pc/wake` | Wake my PC | `{}` |
| `POST /app/indoor/look` | free courts at Glasgow Club for a day | `{ centre: "g" | "s" | "o", date, fresh }` → `{ ok: true, look }` |
| `POST /app/hold` | Hold | `{ centre, date, start, court, courts? }` (`courts`, 2.11: two at once, app only) |
| `POST /app/hold/order` | Let it go / I have paid; Pay (app only) | `{ id, what: "release" | "done" }`, or `{ id, what: "pay", amount, sealed }` |
| `POST /app/card` | (app only) | `{ sealed }`: a card, sealed for `pc.cardKey` |
| `POST /app/card/forget` | (app only) | `{}` |
| `POST /app/card/auto` | (app only, api 3) | `{ sealed }`: the card's security code for automatic payments |
| `POST /app/card/auto/off` | (app only, api 3) | `{}` |
| `POST /app/push` | | `{ token }`: this phone's Expo push token, or null to stop |
| `POST /app/clubspark/look` | (app only) | `{ venue, date, fresh }` → `{ ok: true, look }` (no state): a park's free courts |
| `POST /app/clubspark/book` | (app only) | `{ venue, date, start, hours, court }`: Book now at a park |

```
look = { centre, date, at, by: "pc" | "bot", note, sheet,
         slots: [ { start, end, courts: [ { n, name, price } ] } ] }      // free courts only, by start time
```

### The parks on ClubSpark

Glasgow Life's seven parks (`venues` with `club: "clubspark"`) are read and booked by your PC at
home, because ClubSpark's Cloudflare turns this server away. A request rides on the PC's ping, as
an indoor look or a hold does, and the answer waits for the PC.

Your home connection is what the nightly booking depends on, and ClubSpark's Cloudflare once
challenged it after many quick requests. So, for the seven parks together, whichever phone asks:
a day's look is kept 3 minutes (and reused up to 10 when not asked to be fresh); at most 6 fresh
reads are asked of your PC in any 10 minutes; no fresh read from an hour before the release time
(21:00), to leave the connection quiet before it, and no booking from 35 minutes before it (21:25,
when your PC stops taking them too), either until 30 minutes after it (22:30), nor while the
nightly run is still going (it started, and has not said how every one of tonight's bookings
went, up to an hour after the release); one thing at a time; and after ClubSpark turns your PC
away (`quietUntil` says what counts), while reading or booking, nothing at all for 2 hours. That
pause is said in Telegram (once, with your PC's word for how), as a note (and so a notification),
in the bot's log, in `clubspark.quietUntil`, `lookNo` and `bookNo`, and in the `note` of any look
shown meanwhile. Nothing tries to get round a check. Your PC keeps limits of its own besides
(`lib/clubspark.js` in the booker): the same six reads in ten minutes, four bookings an hour, two
hours after being turned away, no look from 21:00 and no booking from 21:25 to 22:30 by its own
clock, nor either while Windows says the nightly task is running. A look's Chrome is an ordinary
Chrome window kept off the screen, like the nightly run's, not a hidden ("headless") one.

**`POST /app/clubspark/look`** `{ venue, date, fresh }` → `{ ok: true, look }` (no state). `venue` is a
park's key; `date` one of `clubspark.days`. The request waits for your PC: Chrome starts and the
page loads, so a few seconds to about 20, and 45 at the very most.

```
look = { venue, date, at, by: "pc", note,
         slots: [ { start, end, courts: [ { n, name } ] } ] }     // free courts only, by start time
```

- What your PC reads: that park's ClubSpark booking sheet for the day, in a Chrome window of its
  own kept off the screen, as any visitor would (no sign-in, nothing clicked), once: one page load
  and the requests that page makes itself. It sends back the sheet's courts and each free
  interval's "Book" link, the very links its nightly run books from.
- `at`: when ClubSpark showed it (when your PC's answer came). `by`: always `"pc"`.
- `slots`: one per start time with a free court, earliest first, each `end` the end of that
  interval (an hour at Kelvingrove). `n`: the court's number, the number its name ends with (as the
  nightly run reads courts); `name`: ClubSpark's name for it ("Court 3"). A court whose name ends in
  no number, or whose number another court shares, is not offered. For today, times that have
  started are left out.
- `note` (2.10.3): one sentence or more per line, or "" when there is nothing to add (when ClubSpark
  showed it is `at`): "No court free that day." / "ClubSpark lists no courts that day."; then, for
  today, "Times already started aren’t shown."; then, during a pause after ClubSpark turned your PC away, the sentence below that says until when.
- Kept and reused: a day's look (park and date) is not read again within 3 minutes, `fresh` or
  not; without `fresh: true` it is reused for up to 10. Only a look that asks your PC to read counts
  towards the six in ten minutes, whether or not the read then works; one answered from what is
  known asks nothing of anyone. A second look for the same park and day while the first is being
  read waits for that read; one for another day is refused until it is done.
- What a look shows the app is remembered, from the time of the read, for 15 minutes (in memory
  only): Book now can only be asked for a court in those `slots`.

- 400 "A look needs a park (venue) and a date (YYYY-MM-DD)."
- 400 "There is no such park. Send one of: drumchapel, garrowhill, kelvingrove, knightswood, maryhill, queenspark, victoriapark."
- 400 "That day is no longer on offer. Pick again." (a day gone by, or not a calendar date)
- 400 "Not open yet: opens Tue 17 Nov at 22:00." For Kelvingrove it adds " Add it to your list and your PC books it then."
- 409 "ClubSpark turned your PC away at 12:05. Not available until 14:05."
- 409 "Not available 21:00–22:30, around the nightly booking."
- 409 "Not available until the nightly booking has finished."
- 409 "Your PC is booking a court. Look again when it’s done."
- 409 "Your PC isn’t awake. Wake it and try again."
- 409 "That’s 6 reads in ten minutes, to keep your home connection in good standing with ClubSpark. Next at 12:10."
- 409 "Your PC is reading another day at ClubSpark just now. Try again in a moment."
- 409 "ClubSpark turned your PC away just now (<your PC's word for how: ClubSpark showed a "Just a moment" page, or its booking sheet never showed>). Not available until 14:05." (this read was turned away)
- 409 "Your PC didn’t answer in time." (its answer, if it comes later, is still kept and used)
- 409 "ClubSpark didn’t load on your PC in time."
- 409 "Your PC couldn’t reach ClubSpark."
- 409 "Your PC didn’t read it: <its reason>." (its own limits: "the nightly booking starts in 20 minutes", "it has read ClubSpark 6 times in ten minutes and is leaving it alone for a few minutes", "it is booking at ClubSpark just now")
- 409 "Couldn’t read ClubSpark’s sheet (<what went wrong>)." (an answer that does not read as a sheet: never taken for "nothing is free")
- 409 "Your PC isn’t linked, and it’s your PC that reads and books ClubSpark." (not over HTTP)

**`POST /app/clubspark/book`** `{ venue, date, start, hours, court }`. Book now: your PC signs in to
ClubSpark as its nightly run does and books exactly that court for that time, or nothing. `hours`
is 1 or 2. The answer's `state.clubspark.book` is the booking, at stage `"asked"`; from then on it
moves in the state as your PC goes. Bookings are free with the owner's annual pass, and your PC
never pays: at a price in the booking form (with the pass it says "Free"), or a payment step on the
confirm page ("Confirm and pay", or a total above £0.00), it presses nothing more, and the result
says "ClubSpark asked for payment; nothing was booked or paid".

- It never takes another court: if that court is not free for that whole time any more, it ends
  `"gone"` and says so. Only you pick.
- It never tries twice. It presses "Continue booking" only once this bot has said go, and this bot
  says go only to a booking it still follows; your PC does nothing at all unless this bot has heard
  it start.
- How it ends is an ordinary result (`results`, with the court and gate code when booked) with a
  card in Telegram, a note and a notification, as the nightly run's results have. At Kelvingrove
  its id is the nightly run's own (`YYYY-MM-DD@HH:MM`): a one-off on the list for that slot then
  counts as booked. Elsewhere the park is in front of it.
- A booking counts towards its week (`allowance`) as soon as it is booked.
- The checks come in this order: the shape of the request; whether that day and time are on offer;
  whether that court and hour is booked for you already; whether a look showed the app that court
  free, from a read in the last 15 minutes, for the whole time; the week's allowance; then the
  guards in `clubspark.bookNo`.

- 400 "Book now needs a park (venue), a date (YYYY-MM-DD), a start in minutes after midnight, hours (1 or 2) and a court number."
- 400 "There is no such park. Send one of: drumchapel, garrowhill, kelvingrove, knightswood, maryhill, queenspark, victoriapark."
- 400 "That day is no longer on offer. Pick again." or "Not open yet: …" (as for a look)
- 400 "That time is no longer on offer. Pick again." (a start that has passed or is not a five-minute step, one that runs past midnight, a court not from 1 to 20)
- 409 "Court 3 is already booked for you at Queens Park on Fri 20 Nov at 18:00."
- 409 "That list is old. Read the day again, then book a court." (no look in the last 15 minutes showed that court free at that start)
- 409 "Court 2 is not free for two hours from 18:00. Pick another time or court." (or "… for an hour …", where intervals are shorter than an hour)
- 409 "That would be 8 sessions in the week of Mon 16 Nov; the limit is 7." or "That would be 15 hours in the week of Mon 16 Nov; the limit is 14."
- 409, one of the `clubspark.bookNo` sentences:
  - the "turned your PC away" and "still going" sentences above;
  - "Not available 21:25–22:30, around the nightly booking."
  - "Your PC is already booking a court."
  - "Your PC is holding a court at Glasgow Club. Let it go first."
  - "Your PC isn’t awake. Wake it and try again."
  - "That’s 4 bookings in an hour. Next at 13:00."
  - "Your PC isn’t linked, and it’s your PC that reads and books ClubSpark." (not over HTTP)

While a booking is under way: the PC is not put to sleep (`pc.sleepWhy` "Your PC is booking a court.
Wait for it to finish."), no hold starts (`indoor.holdNo` "Your PC is booking a park court. Hold one when it’s done."
park just now. Hold one when it has finished."), and no park is read.

How a booking can end, as its result's `why` reads (`results[].why`, and `clubspark.book.why`
without "It didn’t work: "):

- "It didn’t work: court 1 was no longer free for that time (not free at 18:00 any more), and your PC takes no other court." (or "(free at 18:00, but only until 19:00)")
- "It didn’t work: your PC did not start it: <its reason>." (its own limits, or a hold under way)
- "It didn’t work: <your PC's reason>." Among them: "ClubSpark asked for payment; nothing was booked or paid"; "after "Confirm", ClubSpark went on to a payment page, where your PC paid nothing: check ClubSpark for it"; "DRY_RUN is on in .env on your PC, so it stopped before booking (court 3 was free, Free)"; "ClubSpark showed a "Just a moment" page, so your PC stopped there" (or "ClubSpark's booking sheet never showed, …", "ClubSpark refused a request (HTTP 403), …"); "Chrome could not start (…)"; a sign-in that did not go through; "queenspark has no court 9"; "it could not reach the bot just before booking (…), so it booked nothing"; "this PC went to sleep while booking, so it stopped". Once this bot has given the go-ahead, anything that went wrong (but a court gone, or a stop at a payment step) ends "… It was booking when that happened: check ClubSpark for it", whether your PC's words say so or not.
- "It didn’t work: your PC's booking stopped before it booked anything (<why>)." or "… stopped while it was booking court 3: check ClubSpark for it."
- "It didn’t work: ClubSpark had turned your PC away, so it was not handed to your PC and nothing was booked." (or "your PC's nightly booking run was near, so …")
- "It didn’t work: your PC did not collect it in time, so nothing was booked."
- "It didn’t work: your PC collected it but did not start on it, so nothing was booked."
- "It didn’t work: no word from your PC for four minutes, so I stopped following it. It books nothing without my go-ahead, so nothing was booked." Or, once it had the go-ahead: "It didn’t work: no word from your PC while it was booking court 3: check ClubSpark for it."
- "It didn’t work: your PC was still at it twelve minutes after it took the booking, so I stopped following it. It books nothing without my go-ahead, so nothing was booked." Or, once it had the go-ahead: "… so I stopped following it: check ClubSpark for court 3."
- If your PC's own word comes after any of the endings this bot decided, it replaces it; and a "booked" replaces any ending: a booking stands, and counts towards its week.

### Each request, and every `why` it can give

**`POST /app/once`** `{ venue, type, date, start, hours, auth }`. `hours` is 1 or 2. As `/book`, any start on the hour
or half hour that ends by midnight is taken; `venue.first` and `venue.last` are the hours to offer.
If that date and start are on the list already, nothing changes (not the hours either) and the
answer has `already: true`. The list holds 60 one-off dates at most, however they were asked for
(`/book` in Telegram is refused in the same words).

`venue` (api 3) is any `venues` key, Kelvingrove when it is left out; `type` is the venue's only one
when left out (Scotstoun, which has two, must say which). One venue, date and start once. Glasgow
Club's are an hour long, on the hour (Scotstoun's outdoor courts from 08:00 to 18:00). One that
would pass the week's allowance (see `allowance`; the parks only) is refused too, in the words
`/book` and the Add button use.

`auth` (2.10.1, optional): the app's signature for it (see "Signed bookings"), kept with it. Sent
again with a one-off already on the list, it takes the place of the one that had.

`courts` (2.11, optional): 1 or 2, how many courts to book at once; 1 when left out. 2 is for
Glasgow Club only. Sent again with a one-off already on the list and another number of courts, the
one-off takes that number (its hours still stay as they were), and with it the `auth` sent along,
which covers it; with no `auth`, it is left unsigned, since the signature it had was for the courts it
had. The same number again changes nothing but a signature, as before.

- 400 "A one-off booking needs a date (YYYY-MM-DD), a start in minutes after midnight, and hours (1 or 2)."
- 400 "courts, when sent, must be 1 or 2."
- 400 "Two courts at once are for Glasgow Club only." (`courts: 2` at a park, Kelvingrove included)
- 400 "auth, when sent, must be the 32 lowercase hex characters the app makes with the card's pay key."
- 400 "There is no such venue: send one of the keys in state.venues."
- 400 "Gorbals has indoor courts only." (or "<Park> has outdoor courts only.")
- 400 "Scotstoun has indoor and outdoor courts: send type, indoor or outdoor."
- 400 "Glasgow Club courts are booked an hour at a time."
- 400 "Scotstoun's outdoor courts are open from 08:00 to 18:00."
- 400 "Slots start on the hour. Try a time like 19:00."
- 400 "That slot runs past midnight. Try an earlier time."
- 400 "Tue 10 Nov at 19:00 has already passed." (that day and time)
- 400 "That is more than 90 days away. Try a nearer date."
- 409 "Your list already has 60 one-off dates, which is as many as I keep. Remove one first."
- 409 "That would be 8 sessions in the week of Mon 23 Nov; the limit is 7." or "That would be 15 hours in the week of Mon 23 Nov; the limit is 14."

**`POST /app/once/remove`** `{ venue, date, start }` (`venue` Kelvingrove when left out). One that is
not on the list is no error: the answer is the state as it is.

- 400 "To remove a one-off booking, send its date (YYYY-MM-DD) and its start in minutes after midnight."

**`POST /app/plan`** `{ day, start, hours }`. Sets or changes that weekday, at Kelvingrove (a
`venue` other than `"kelvingrove"` is refused): Kelvingrove's weekly entries on that day give way to
this one, as `/set` does. `POST /app/weekly` takes any venue, and several a day. A change that would pass the week's allowance in a
week it adds to is refused, as `/set` and the weekly buttons refuse it; a weekly time adds nothing
to a week whose release for that day has gone by.

- 400 "A weekly booking needs a day (mon to sun), a start in minutes after midnight, and hours (1 or 2)."
- 400 "This sets Kelvingrove's weekly time, as /set does. Add a weekly booking at another venue to the weekly list."
- 400 "Slots start on the hour. Try a time like 19:00."
- 400 "That slot runs past midnight. Try an earlier time."
- 409 "That would be 8 sessions in the week of Mon 23 Nov; the limit is 7." (or the same for 14 hours)

**`POST /app/plan/remove`** `{ day }`. `day` may be `"all"`, as `/off all`. Kelvingrove's entries that
day (or every day) go; the other venues' stay. A day that was not set is no error.

**`POST /app/weekly`** `{ venue, type, day, start, hours, on, courts, auth }` (api 3): a weekly booking at any venue.
`type` as for `POST /app/once`; `on` true when left out; `courts` (2.11, optional) 1 or 2, as for
`POST /app/once` (2 at Glasgow Club only), 1 when left out; `auth` (2.10.1, optional) its signature,
over the v2 words when `courts` is 2 (see "Signed bookings"). The answer's `state.weekly` has it,
with its id.

- 400 "A weekly booking needs a venue, a day (mon to sun), a start in minutes after midnight, and hours (1 or 2)."
- 400 the venue, type, slot, `courts` and `auth` sentences of `POST /app/once`
- 409 "There is already a weekly booking at Gorbals on Wednesdays at 18:00." (that venue, day and time)
- 409 "Your list already has 30 weekly bookings, which is as many as I keep. Remove one first."
- 409 "That would be 8 sessions in the week of Mon 23 Nov; the limit is 7." (or 14 hours; the parks only)

**`POST /app/weekly/change`** `{ id, venue?, type?, day?, start?, hours?, courts?, auth? }`: the entry as it will be is
read whole, as a new one is (a venue changed without a type takes that venue's own, or must say
which), and checked against the others and the allowance; it keeps its id and whether it is on. Its
`courts` (2.11) stay as they were unless sent: an entry of two courts moved to a park must send
`courts: 1`, or is refused as a new one would be. Its signature (2.10.1): the `auth` sent; else the
one it had, as long as its venue, type, day, start, hours and (2.11) courts stay as they were; a
change of any of them without a new `auth` leaves it unsigned. The bot cannot make a signature: a
change of courts is signed afresh by the app (Face ID).

- 400 "To change or remove a weekly booking, send its id."
- 400 any sentence of `POST /app/weekly` about the entry itself
- 409 "That weekly booking is no longer on your list."
- 409 the duplicate and allowance sentences of `POST /app/weekly`

**`POST /app/weekly/on`** `{ id, on }`: switched on (checked against the allowance) or off.

- 400 "To switch a weekly booking on or off, send its id and on (true or false)."
- 409 "That weekly booking is no longer on your list." / the allowance's sentence

**`POST /app/weekly/remove`** `{ id }`.

- 400 "To change or remove a weekly booking, send its id."
- 409 "That weekly booking is no longer on your list."

**`POST /app/weekly/auth`** `{ items: [{ id, auth }] }` (2.10.1): signatures made afresh (with a new
card, or when automatic payments are switched on), one to 30 at a time: weekly bookings by their
`id` (8 hex characters), one-off dates by theirs as `state.once` gives them (`"gorbals/2026-11-25@18:00"`;
Kelvingrove's `"2026-11-25@18:00"`). All or nothing: one that is no longer on the list refuses the
lot, and nothing changes. It stays for apps before 2.11, which use it; an app from 2.11 re-signs
nothing by itself (it checks `weekly[].auth` and `once[].auth`), though it may still use it.

- 400 "To sign bookings, send items: [{ id, auth }], one to 30 of them, each a weekly booking's or a one-off date's id and its 32 hex characters." (also for an id twice)
- 409 "That weekly booking is no longer on your list (<id>). Nothing was changed." (or "That one-off date ...")

- 400 "To stop a weekly booking, send its day (mon to sun, or all)."

**`POST /app/order`** `{ order }`. Fewer than six courts are taken as `/order` takes them: the ones
left out go last, in number order.

- 400 "Courts 1 to 6, each once."

**`POST /app/pause`** `{ paused }`, true or false.

- 400 "Send paused as true or false."

**`POST /app/pc/sleep`** `{}`. The request waits for the PC's next ping, which comes within
seconds (`pc.sleepAsked`); the PC then counts as asleep. If the PC itself will not sleep, the bot
says so in Telegram and in a note ("Your PC stayed awake").

- 409, one of the `pc.sleepWhy` sentences above.

**`POST /app/pc/wake`** `{}`. Sends the wake-up packet (`pc.wokeAt`); `pc.state` turns `"awake"` when
the PC answers.

- 409, one of the `pc.wakeWhy` sentences above, or "The wake-up could not be sent. Try again."

**`POST /app/indoor/look`** `{ centre, date, fresh }` → `{ ok: true, look }` (no state). `date` is
today or one of the eight days after. `fresh: true` is Telegram's Refresh: a day is read at most
once a minute, or once in ten seconds with `fresh`. The request waits for the read: a second or
two as a rule, 20 seconds at most when the PC does not answer. One look is asked of the PC at a
time: a newer look for another day takes the place of one still waiting, which is then refused.

The app, all linked phones together, may have the sheet read afresh 12 times in any minute. A look
that needs a fresh read (by the PC or by the bot) is one of the 12 whether or not the read then
works; a look answered from what the bot already knows is not counted. The 13th is refused until
a minute after the first. Telegram's own looks are neither counted nor held back.

What a look shows the app is remembered for 15 minutes, in memory only: a hold can only be asked
for a court in a look's `slots` (see `POST /app/hold`).

- `at`: when the sheet was read. `by`: `"pc"` (your PC read it) or `"bot"` (the bot could itself).
- `slots`: the courts that can be booked now, by start time; `n` is the court's number, `name`
  Glasgow Club's name for it ("Tennis Hall Court 3"; "Outdoor Tennis Court 1" at Scotstoun outdoor), and `price` is always null: the sheet
  carries no price (it is known once a court is held: `hold.price`).
- `note` (2.10.3): what Telegram's card says about that day but its "Updated 12:00." line (the app
  shows `at` itself), one sentence or more per line, or "" when there is nothing more (a day with
  free courts): "No court free that day." / "Glasgow Club lists no courts that day. Open the sheet
  to check." / for a day (or
  hours) not open for booking yet, when it opens and what is free as it stands. Courts that are
  not open for booking yet are in the note only, never in `slots`.
- `sheet`: that centre's sheet for that day on Glasgow Club's site, to book and pay there by hand.

- 400 "A look needs a centre (g, s or o) and a date (YYYY-MM-DD)."
- 400 "There is no such centre: send g for Gorbals, s for Scotstoun (indoor) or o for Scotstoun outdoor."
- 400 "That day is no longer on offer. Pick again."
- 409 "That’s 12 looks in a minute. Wait a minute, then look again."
- 409 "Not available until 22:10, around the nightly booking."
- 409 "Your PC reads Glasgow Club’s courts, and it isn’t awake. Wake it and try again, or open the sheet."
- 409 "Your PC did not answer in time, so I could not read Glasgow Club's free courts."
- 409 "Glasgow Club's site is checking visitors from your home connection just now, so your PC cannot read the free courts. It will not be asked again for an hour."
- 409 "Glasgow Club's site says it is being asked too often, so it will not be asked again for an hour."
- 409 "Glasgow Club's site did not answer in time."
- 409 "Your PC could not reach Glasgow Club's site." or "I could not reach Glasgow Club's site."
- 409 "Glasgow Club's site did not give me the free courts (<what went wrong>)." (among them "another look took its place")
- 409 "Your PC did not read the <label> sheet. It says: “no such centre or day”." (2.9.3: your PC does
  not read that sheet; for `"o"` it goes on " A PC not yet updated for Scotstoun's outdoor courts
  answers so: update the booker on your PC.")

**`POST /app/hold`** `{ centre, date, start, court, courts }`. Your PC signs in to Glasgow Club, puts that
court in the basket and stops at the payment page; paying is the owner's. The answer's `state.hold`
is the new hold, at stage `"asked"`. The guards are the Hold button's own.

`courts` (2.11, optional): two courts at once at the same start: `[3, 4]`, 1 or 2 different court
numbers, lowest first, the first of them `court` (`courts: [3]` is the same as leaving it out, as an
app older than 2.11 does: `court` alone). Your PC puts every one of them into the basket, reads the
price of each, and takes all or none: if any has gone, it takes out what it put in and says which
court went (`"failed"`). Then one payment covers the total (`hold.price`).

Telegram only offers Hold under a court that a sheet showed free. The app's equal: the centre,
date, start and court (each of `courts`) must be ones that a `POST /app/indoor/look` answered to the
app (any linked phone) in the last 15 minutes showed in its `slots`. What was shown is kept in memory only, so
after a restart of the bot the app must look again. `indoor.holdNo` does not cover this (it cannot
know which court will be asked for). The checks come in this order: the shape of the request, then
whether that time is on offer at all, then this, then the guards.

- 400 "A hold needs a centre (g, s or o), a date (YYYY-MM-DD), a start in minutes after midnight, and a court number."
- 400 "There is no such centre: send g for Gorbals, s for Scotstoun (indoor) or o for Scotstoun outdoor."
- 400 "At most 2 courts at once." (2.11: three or more in `courts`)
- 400 "courts, when sent, must list court numbers, each once and lowest first, starting with court." (2.11: not a list of whole numbers, a court twice, not lowest first, or a first that is not `court`)
- 400 "That time is no longer on offer. Pick again." (a time that has passed, a day not among the nine, a court not from 1 to 20, a start that is not a five-minute step)
- 409 "That list is old. Read the day again, then hold a court." (no look in the last 15 minutes showed the app that court, or each of `courts`, free then)
- 409, one of the `indoor.holdNo` sentences:
  - "Your PC is already holding a court."
  - "Your PC is booking a park court. Hold one when it’s done." (Book now, under way)
  - "Your PC isn’t awake. Wake it and try again."
  - "Not available 21:25–22:15, around the nightly booking. The sheet still opens."
  - "Glasgow Club was checking visitors from your home connection. Not available until 13:00."
  - "That’s 6 holds in an hour. Next at 13:00."
  - "Your PC isn’t linked, and it’s your PC that holds the court." (not over HTTP)

**`POST /app/hold/order`** `{ id, what }`. `release` is Stop (before the basket) or Let it go;
`done` is I have paid (`pay` is under "Paying from the app"). It works on a hold started from either side, as Telegram's buttons do. The
PC hears of it within a few seconds; until then `can.release` and `can.done` are false and the
hold's `lines` say what is being done. A `release` before the PC has collected the hold ends it
there and then (`ended: "stopped"`). A `done` before the court is in the basket is refused and
changes nothing, whether or not the PC has collected the hold yet: it never stops a hold.

- 400 "To act on a hold, send its id and what to do: release, done or pay."
- 409 "No longer following that hold. Your PC lets it go when its time is up."
- 409 "That hold is over."
- 409 "It is not in your basket yet." (`done` at any stage before `"held"`)
- 409 "Already letting it go." or "Already checking."
- 409 while your PC pays: "Your PC has been told to pay. Wait for its answer." / "Your PC is paying
  for it. Wait for its answer." / "Your PC has pressed Pay. Wait for the answer." / "Your PC may have
  pressed Pay. Wait for the answer."

**`POST /app/push`** `{ token }`. An Expo push token (`ExponentPushToken[…]` or `ExpoPushToken[…]`),
or null to stop. A token is kept for one phone only: given by a second, it moves to that one.

- 400 "That is not an Expo push token. Send one, or null to stop notifications."

## Paying from the app

The card is typed into the app, sealed there for your PC's key, and kept on your PC. Pay sends the
price the owner confirmed in the app and the card's security code, sealed the same way. The PC types
the card and the code into Glasgow Club's payment page and presses Pay, once. The bot only passes
sealed boxes on: it has no key to open them with. Telegram has no Pay button, since the security
code only ever comes from the app; its card says "Pay in the app" where the app can pay.

### The sealed box

Both the card and the security code travel as a sealed box: standard base64 (the `+` `/` alphabet,
with `=` padding, and nothing else: no spaces, no line breaks) of

```
ephemeral public key (32 bytes) ‖ nonce (24 bytes) ‖ nacl.box(utf8(JSON), nonce, pcPublicKey, ephemeralSecretKey)
```

`pcPublicKey` is `pc.cardKey`, decoded. The ephemeral key pair is made afresh for each box
(`nacl.box.keyPair()`) and its secret half dropped once the box is made; the nonce is 24 random
bytes. With tweetnacl 1.0.3:

```js
const eph = nacl.box.keyPair();
const nonce = nacl.randomBytes(24);
const box = nacl.box(new TextEncoder().encode(JSON.stringify(what)), nonce, fromBase64(state.pc.cardKey), eph.secretKey);
const sealed = toBase64(Uint8Array.from([...eph.publicKey, ...nonce, ...box]));
```

A box is at most 1024 base64 characters, and at least 74 bytes once decoded. That, and that it is
canonical base64, is all the bot checks; it passes on exactly what came. It never writes a sealed
box to its log or to disk, and drops it once it is handed to the PC (or dropped unsent).

- The card: `{ number, expMonth, expYear, name, payKey }`. `number`: a string of 12 to 19 digits
  (spaces and dashes are ignored) that passes the Luhn check. `expMonth`: 1 to 12 (a number; "01" is
  taken too). `expYear`: four digits (two are taken as 20YY). The card must not have expired (it is
  good to the end of its month), and must expire within 20 years. `name`: the name on the card, up
  to 60 characters, or left out. `payKey`: the app's pay key, standard base64 of 32 random bytes
  (`nacl.randomBytes(32)`), made by the app for this card and kept in the iPhone's keychain; it goes
  nowhere else. The PC keeps it with the card, protected, and refuses a card without one. There is
  no security code in the card: the PC never keeps one.
- The security code, for one payment: `{ cvc, id, amount, payKey, centre, date, start, court }`.
  `cvc`: 3 or 4 digits, as a string. `id`: the hold's `id`. `amount`: the amount the owner
  confirmed, exactly as in the order (`"£23.00"`). `payKey`: the pay key sent with the card the PC
  keeps. `centre`, `date`, `start`, `court`: the hold's own, as in `state.hold` (`"g"`, `"s"` or `"o"`; say `"g"`,
  `"2026-11-20"`, `1080`, `3`). For a hold of two courts (2.11) it also has `courts`, the hold's own
  (`[3, 4]`), `court` is the first of them and `amount` the total (`"£46.00"`); for one court it is as
  before, without `courts`. Your PC binds the box to its hold's courts: with two, `courts` must be
  exactly the same list, in the same order, and `court` its first; with one, `courts` must be absent or
  `[court]`. Anything else is "the security code was sealed for another payment".
- Or, since the PC's booker 2.10.2, the same without `cvc` and with `use: "kept"`:
  `{ use: "kept", id, amount, payKey, centre, date, start, court }` (and `courts`, as above, for two),
  sealed the same way. It asks
  your PC to pay with the security code it keeps for automatic payments (`card.auto`), so the owner
  types no code in the app. The bot cannot tell the two apart and passes either on unopened, as it
  came; the checks above (the pay key, the binding to this hold, court and amount, one order per
  hold) are your PC's, for both.

Why the pay key and the binding: the PC's key is public (the bot relays it), so anybody, the bot
too, can seal a box for the PC. Only the app knows the pay key, so a security code without it was
not sealed by the app, and the PC uses it for nothing ("the security code did not come from the
app the card was given in, so it was not used"). A code sealed for another hold, court or amount is
refused too ("the security code was sealed for another payment"), and the PC notes each hold it
took an order to pay for and takes no second one for it ("an order to pay for this hold came
before, and a hold is paid for once at most"): a box kept by anyone on the way is of no use for any
other payment. Only the phone that sent the card has its pay key: to pay from another linked phone,
send the card from that phone (it replaces the card kept, and its pay key).

The app should keep the first `pc.cardKey` it sealed for, and ask the owner before sealing for a
different one. (The PC makes its key once, and a new one only if Windows can no longer unlock the
old; its card must then be given again.) The owner can compare the two: `node book.js --card-key` on
the PC prints the key and its fingerprint, the first 16 hex characters of the SHA-256 of the key's 32
bytes in groups of four ("a1b2 c3d4 e5f6 0718"), which the app can show as well.

### Each request, and every `why` it can give

**`POST /app/card`** `{ sealed }`: a card for your PC to keep, in place of any card kept before.
The answer is the state, with `card.pending` true. The card waits for the PC's next ping (within
seconds while it is awake), two minutes at most; a newer card takes its place. The PC opens it,
checks it, keeps it (protected by Windows for the user signed in there, in the booker's `vault`
folder) and says how it went on the ping after: `card` then shows the card kept, or `card.why` why not.

- 400 "To keep a card on your PC, send it sealed for your PC's card key: { sealed }."
- 400 "That is not a sealed box I can pass on: it must be standard base64, at most 1024 characters, of a key, a nonce and the box."
- 409 "Your PC has not given me its card key yet. It does with every ping while it is awake: wake it, or wait a minute, then try again."
- 409 "Your PC is not awake, and it is your PC that keeps the card. Wake it and try again."
- 409 "Your PC is paying for a court just now. Try again once that is over."

**`POST /app/card/forget`** `{}`: your PC deletes the card it keeps, on its next ping, whenever that
comes (`card.forgetting` until then). A card on its way that the PC has not collected yet is dropped
at once, unseen by the PC; if the PC keeps no other card, that is all there is to do.

- 409 "Your PC keeps no card." (the PC has said so, and nothing is on its way)
- 409 "Your PC is paying for a court just now. Try again once that is over."

**`POST /app/hold/order`** `{ id, what: "pay", amount, sealed }`: pay for the held court with the card
your PC keeps. `amount`: the price the owner confirmed, which must be `hold.price` exactly (for two
courts, 2.11, the total for both: the PC's order is for that amount, one payment). `sealed`:
the security code, sealed as above. The answer is the state: the hold's lines say the PC is being
told. The order waits for the PC's next note about the hold (one comes every few seconds), half a
minute at most, and goes with the answer to it, once; the sealed code is not kept after that. The PC
says `"paying"` before it types a key. If its next note is from the basket instead, the order did
not reach it: nothing was pressed, and Pay may be asked for again. The checks come in this order:

- 400 "To act on a hold, send its id and what to do: release, done or pay."
- 400 "To pay, send the hold's id, what: "pay", the amount you confirmed (such as "£23.00") and the sealed security code."
- 400 "That is not a sealed box I can pass on: it must be standard base64, at most 1024 characters, of a key, a nonce and the box."
- 409 "No longer following that hold. Your PC lets it go when its time is up."
- 409 "That hold is over."
- 409 "Your PC is paying for it already." (a second Pay while it pays, or after the press)
- 409 "Your PC has been told to pay for it already." (a second Pay while the order is on its way)
- 409 "Your PC couldn’t pay for it and won’t try again. Pay at your PC, or let it go."
- 409 "It is not in your basket yet."
- 409 "Already letting it go." or "Already checking."
- 409 "Your PC is forgetting its card."
- 409 "Your new card has not reached your PC yet. Try again in a moment."
- 409 "There is no card on your PC. Add one in the app first."
- 409 "Your PC cannot pay for this court: <the PC's reason>." The PC's reasons: "no card is kept on
  this PC", "the card kept on this PC has expired", "this PC has no card key yet (the PC link makes
  it when it starts)", "the payment page does not have the three card boxes I know", "that would be
  more than 2 payments from this PC today (GLASGOW_PAY_PER_DAY)", "GLASGOW_PAY_PER_DAY in .env is 0,
  so no payment is made from this PC", "BOT_URL in the .env file on your PC is not an https address,
  and an order to pay is only taken from a bot reached over https", and the PC's own note of
  payments made being unreadable.
- 409 "Your PC has not said that it can pay for this court." (its booker is older than 2.9)
- 409 "Your PC didn’t say both courts are in your basket, so it isn’t asked to pay." (2.11: a hold of two courts whose note from the basket did not name both; a PC whose booker is older than 2.11 holds the first alone, at that court's price)
- 409 "Your PC could not read the price, so it cannot pay for this court."
- 409 "No word from your PC for over a minute, so it isn’t asked to pay."
- 409 "Too little time left to pay from here. Pay at your PC, or let it go." (under 30 seconds of `until`)
- 409 "The price is £23.00, not £25.00. Check it before you pay." (`amount` is not `hold.price`; for two courts "The price is £46.00, not £23.00. …")

### What the PC does

1. It unlocks the card it keeps, opens the code (sealed by the app the card came from, for this
   hold, this court and this amount), notes that this hold has had its order, and checks the
   payment page: one Pay button reading exactly "Pay " and the amount, and the payment provider's
   three card boxes (card number, expiry, security code). If anything is not as it should be it
   types nothing and says why: the hold stays `"held"`, and its lines say "Your PC could not pay: …",
   with reasons such as "the amount confirmed in the app (£25.00) is not the price read at the basket
   (£23.00)", 'the payment page says "Pay £25.00", not the £23.00 you confirmed', "the security code
   did not come from the app the card was given in, so it was not used", "the security code was
   sealed for another payment", "an order to pay for this hold came before, and a hold is paid for
   once at most", "the card kept on this PC has expired", or the daily limit's. For two courts (2.11)
   the amount is the total, and the page must also show exactly the two courts it put in (see "Two
   courts at once (2.11)").
2. `"paying"`: it types the card and the code into the three boxes and reads each back, notes the
   payment for its daily limit (`GLASGOW_PAY_PER_DAY` on the PC, two unless set), and presses Pay,
   once. Stopped before the press, it goes back to `"held"`, having pressed nothing.
3. It waits for the answer. Your bank wanting your approval (its page, with no box to type in):
   `"approve"`, and the PC waits five minutes for it. Your bank asking for a code to be typed in: the
   PC stops there, and never types or passes on such a code (`"failed"`). The payment page coming back
   with an error and its Pay button: `"failed"`, with what the page said. The payment page moving on:
   the PC looks at the Bookings page, and calls it `"booked"` only if the court is listed there as new.
   No answer in time: `"unsure"`.
4. After the press nothing is taken out of the basket, and every ending says that Pay was pressed,
   or may have been (Chrome gave the PC no answer to the press). The CVC is held in the PC's memory
   for that one payment, never written down.

None of this has met Glasgow Club's real payment page or a real bank's check. The PC tells your
bank's approval page from its code page by the page's shape (a new frame, or a page off Glasgow
Club's site, with or without a box to type in), and could read a real one wrongly either way: taken
wrongly for a code page, the payment is left unfinished; wrongly for an approval page, the PC waits
five minutes and then looks at the Bookings page.

## Weekly bookings at any venue (api 3)

**The parks.** Every park opens a day `daysAhead` (7) days ahead at `releaseMin` (22:00). Your PC's
nightly run (21:55) books Kelvingrove's jobs first, exactly as before (its own path, with `order`),
then each other park's in the same run, on ClubSpark, the lowest-numbered court that is free for the
whole slot. Results carry the venue in their id. The weekly allowance (7 sessions, 14 hours a week,
across the parks) applies as before.

**Glasgow Club.** Gorbals (`g`), Scotstoun indoor (`s`) and Scotstoun outdoor (`o`) open a day 7 days
ahead at 00:00. On a night with one of their jobs, the nightly run stays awake past midnight (its
Windows task may run three hours: re-run `schedule.ps1` on the PC once). At 00:00 it puts the
lowest-numbered court free at the job's start into your basket and, when automatic payments are on,
pays for it with the card your PC keeps and the security code kept beside it: only if the price on
the slot ("Book for £23.00") is the payment page's own and at most `GLASGOW_AUTO_PAY_MAX` (£30
unless the PC's `.env` says), and every check of the payment page passes (the page come to from the
basket, one thing in its basket, one amount, empty card boxes, no bank's check showing, the press
once). If your bank asks you to approve the payment, the bot says so at once: a note of kind
`"warn"`, "Approve the payment in your bank's app" ("Your PC is paying £23.00 for Gorbals · Wed 25 Nov
· 18:00–19:00, court 1. Approve it in your bank’s app within five minutes."), which is also a notification. Then your Bookings page says whether it was booked, and the
result says so: booked, with `court`, `price` and `paid: true`; or not, with `why` and `paid`. With
automatic payments off nothing is taken: the result is "failed", "automatic payments are off on your
PC, so it did not take a court", `paid: false`. A court taken and then not paid for (a check that did
not pass, a price over the cap) is taken out of the basket again; after a press nothing is taken out.
Each booking is paid for once at most, whatever happens (a run that starts again pays nothing twice):
since 2.10.1 by what it is (venue, court type, date, start and length), whatever id it is handed with.
None of it counts toward the allowance.

A Glasgow Club job carries `courts` (2.11): 1, or 2 for a weekly booking or one-off date of two courts
at once (`{ id, date, start, end, hours, releaseAt, venue, type, centre, from, auth?, courts, open? }`;
the parks' jobs are as they were, without it). For two, your PC takes the two lowest-numbered courts
free for the whole slot, or none: if fewer than two are free by the end of its look, it takes none, and
the result is `"failed"`, `paid: false`, with a why such as "Only 1 of 2 courts was free, so none was
taken". Each court's price must be its slot's own and at most `GLASGOW_AUTO_PAY_MAX`; it pays the total
once (one payment toward `GLASGOW_PAY_PER_DAY`), and calls it booked only when the Bookings page lists
both. The result is one for the slot: `court: "3 & 4"`, `courts: [3, 4]`, `price` the total (see
`results`). It is paid once at most, by what it is, as above: one payment for the slot.

Since 2.10.1 your PC also takes no court for a Glasgow Club job:
- that the app has not signed with the card your PC keeps ("this booking was not signed in the app
  with your card: open it in the app and save it again"; see "Signed bookings");
- more than half an hour after its day opened, by your PC's own clock ("it was 00:40 when your PC came
  to it, more than half an hour after Glasgow Club opened the day at 00:00, so it took no court (you may
  have booked it by hand meanwhile)"), or after it was asleep while it waited for 00:00 ("your PC was
  asleep (or stood still) from 22:10 to 07:10 while it waited for 00:00, so it took no court");
- while anything is in your basket (an earlier booking's court whose payment is not known, say: it is
  left as it is); and a court it gives back is that booking's own line, nothing else in the basket.
A payment page that comes back saying the payment did not go through after Pay was pressed is
`paid: "maybe"`, with the page's words: whether money moved is for your banking app to say. What
cannot be paid for at all (automatic payments off, unsigned, too late) is said as soon as the run
starts, and the PC is not kept awake for it. A one-off at Glasgow Club is booked at its midnight; one
added after its day opened is booked at the next run, before midnight (`open`), in a sign-in of its
own; one that was on the list at its midnight is not tried again after it (by then you may have
booked it by hand after hearing it was not booked).

Around a night's Glasgow Club job your PC is left to it: Sleep is refused from 23:00 ("Staying awake
for the 00:00 booking."), holds from 23:25 to 00:30 ("Not available 23:25–00:30, around the midnight
booking. The sheet still opens."), and looks at Glasgow Club's sheets from 23:50 to 00:10 ("Not
available until 00:10, around the midnight booking."). A PC whose booker is older than 2.10 is handed
Kelvingrove's jobs alone (it would book any other at Kelvingrove); every other job then has the
result "your PC's booker does not book <place> yet: update it on your PC. Your PC did not try it".
Update the PC first.

### Automatic payments

**`POST /app/card/auto`** `{ sealed }`: turns them on. The box is sealed exactly as the card and Pay's
code are (see "The sealed box"); what is sealed is

```
{ "use": "auto", "cvc": "123", "payKey": "<the card's pay key: standard base64 of its 32 bytes>", "last4": "4242", "at": 1763661600000 }
```

- `use`: exactly `"auto"`. A Pay code (which has `id` and `amount`) never works as this, nor this as one.
- `cvc`: 3 or 4 digits, as a string. `payKey`: the pay key sent with the card your PC keeps.
  `last4`: that card's last four digits: the code is bound to that card.
- `at`: when it was sealed (ms since 1970). Your PC takes it only within 10 minutes of `at`, and
  only if `at` is later than the last time automatic payments were turned off or the card changed:
  a box kept by anybody on the way, replayed later, turns nothing back on.

The PC keeps the code beside the card, protected by Windows the same way (`vault\auto.json`), until
it is turned off, or the card is replaced or forgotten. The bot passes the box on as it came, once,
with the PC's next ping (two minutes at most), and keeps nothing of it: not in its log, not on disk.
The answer is the state, with `card.autoAsked: "on"` until the PC has said how it went (`card.auto`,
or `card.autoWhy`). The PC's reasons: "the security code did not come from the app the card was given
in", "the security code was sealed for another card", "the security code is too old: turn automatic
payments on again", "the security code does not read as one", "no card is kept on this PC".

- 400 "To turn automatic payments on, send the card's security code sealed for your PC's card key: { sealed }."
- 400 "That is not a sealed box I can pass on: it must be standard base64, at most 1024 characters, of a key, a nonce and the box."
- 409 "There is no card on your PC. Add one in the app first."
- 409 "Your PC has not given me its card key yet. It does with every ping while it is awake: wake it, or wait a minute, then try again."
- 409 "Your PC is not awake, and it is your PC that keeps the code. Wake it and try again."
- 409 "Your new card has not reached your PC yet. Try again in a moment."
- 409 "Your PC is paying for a court just now. Try again once that is over."

**`POST /app/card/auto/off`** `{}`: turns them off: the PC deletes the code with its next ping. Since
2.10.1 this is asked of the PC every time, even when its last ping said it keeps no code (off twice
is off); an "on" that has not reached it yet is dropped, unseen.

### Signed bookings (2.10.1)

Your PC pays automatically only for a Glasgow Club job whose booking the app signed with the card's
pay key, which only the app and your PC know (it is sealed with the card; see "The sealed box"). The
bot keeps each signature with its weekly booking or one-off date and hands it to the PC with the job
(`auth`, and `from`: `"weekly"` or `"once"`), but cannot make one: so it cannot have your PC pay for
anything you did not save in your app.

- The signature: the first 16 bytes of HMAC-SHA-512, keyed with the pay key's 32 raw bytes (its
  standard base64, decoded), over the UTF-8 words, as 32 lowercase hex characters.
- The words: a weekly booking `court-broker/weekly/v1|<venue>|<type>|<day>|<start>|<hours>`; a one-off
  date `court-broker/once/v1|<venue>|<type>|<date>|<start>|<hours>`. `venue` a `venues` key, `type`
  `indoor` or `outdoor`, `day` `mon` to `sun`, `date` YYYY-MM-DD, `start` minutes after midnight and
  `hours` a whole number, both written as plain numbers.
- Two courts at once (2.11, `courts: 2`): the v2 words, with the number of courts on the end:
  `court-broker/weekly/v2|<venue>|<type>|<day>|<start>|<hours>|<courts>` and
  `court-broker/once/v2|<venue>|<type>|<date>|<start>|<hours>|<courts>`. One court (`courts: 1`, or
  none said) keeps the v1 words exactly, so every signature made before 2.11 stays good. Your PC
  checks a job with the words its `courts` calls for, so a signature made for one court is no good for
  two, nor the other way. A change of `courts` needs a new signature, which the app makes (with Face
  ID); the bot cannot make one, and keeps none that no longer fits (see `POST /app/weekly/change` and
  `POST /app/once`).
- Worked example: pay key 32 bytes of 0x5a (`WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo=`);
  `court-broker/weekly/v1|gorbals|indoor|wed|1080|1` → `c019d5fd3bab087b5a29d9b76c6c69a7`;
  `court-broker/once/v1|gorbals|indoor|2026-11-25|1080|1` → `7e8fea3af1d796d60bf594483ef7a054`;
  and for two courts `court-broker/weekly/v2|gorbals|indoor|wed|1080|1|2` → `775461b248015a591db102a1d095807d`;
  `court-broker/once/v2|gorbals|indoor|2026-11-25|1080|1|2` → `f12b7ca19d33d2b217aa219c5be3fa95`.
- The app sends it with `POST /app/weekly`, `/app/weekly/change` and `/app/once` (`auth`). Apps
  before 2.11 also sign everything afresh with `POST /app/weekly/auth` when the card changes (the
  signatures go with the old pay key) or automatic payments are switched on; that request stays, for
  them. The state says `signed` for each (kept for apps before 2.11) and, since 2.11, the signature
  itself (`weekly[].auth`, `once[].auth`: the 32 hex characters as the app sent them, or null). It is
  no secret: only the app and your PC, which have the pay key, can make one, and showing it lets
  nobody else make another. An app from 2.11 re-signs nothing by itself: it checks each paid booking's
  `auth` against the card's pay key, with the words above, and asks the owner to save (and so sign)
  any that does not match again. Kelvingrove's and
  the other parks' are kept too, though nothing is paid there. The one-line `/backup` leaves them out, as it does the
  linked phones: after a start from it, `signed` is false and `auth` null until the app signs again.
  The bot's log and Telegram never show one.
- The PC checks it before it takes a court, with the pay key of the card it keeps, over the job's own
  venue, type, start and hours (and, 2.11, `courts`: v1 or v2 by it), and the weekday of its date (`from: "weekly"`) or its date
  (`from: "once"`). A job at its midnight goes with its weekly booking's signature when there is one,
  else its one-off's; an `open` one-off with its own alone (a weekly signature names a weekday, not a
  date), and the PC takes an open job only so. A Glasgow Club job's `courts` (2.11) is always that of
  the entry whose signature it goes with (or, unsigned, of the entry it comes from).

## Two courts at once (2.11)

For eight players: two courts at Glasgow Club (Gorbals, Scotstoun indoor or Scotstoun outdoor) for
the same hour, held or booked together. The parks book one court, as before. At most two
(`MAX_COURTS`, in `lib/venues.js` here and in the PC's booker). Both go into the one basket, so both
are held the moment they are taken, and one payment covers the total. All or nothing: if either
cannot be taken, neither is kept (Glasgow Club's bookings cannot be cancelled, so half a booking would
waste money), and the reason names the court. Fields are only added: `api` stays 3.

The shapes, side by side:

| Who to whom | What | One court | Two courts |
| --- | --- | --- | --- |
| app → bot | `POST /app/hold` | `{ centre, date, start, court }` (or `courts: [3]`) | `{ centre, date, start, court: 3, courts: [3, 4] }` |
| bot → app | `state.hold` | `court: 3, courtName: "Court 3", courts: [3], courtNames: ["Court 3"]`, `price` | `court: 3, courtName: "Court 3", courts: [3, 4], courtNames: ["Court 3", "Court 4"]`, `price: "£46.00"`, `prices: ["£23.00", "£23.00"]` |
| bot → PC | the ping's answer | `{ hold: { id, key, date, start, court: 3, courts: [3] } }` | `{ hold: { id, key, date, start, court: 3, courts: [3, 4] } }` |
| PC → bot | `POST /agent/hold` notes | `court: 3` (a 2.11 booker adds `courts` only for two courts) | `court: 3, courts: [3, 4]`, `price` the total, `prices` each court's |
| app → PC | the sealed code (Pay) | `{ cvc, id, amount, payKey, centre, date, start, court }`, as before | the same with `courts: [3, 4]`, `amount` the total; or `{ use: "kept", … }` with `courts` too |
| app → bot | `POST /app/hold/order` (pay) | `amount: hold.price` | `amount: hold.price`, the total |
| bot → app | `state.results[]` | `court: "3"`, `courts: null` (or `[3]` when the PC names it so) | one result for the slot: `court: "3 & 4"`, `courts: [3, 4]`, `price` the total, `paid` |
| app → bot | `POST /app/weekly`, `/change`, `/app/once` | `courts` left out, or `1` | `courts: 2`, signed with the v2 words |
| bot → app | `state.weekly[]`, `state.once[]` | `courts: 1`, `auth` (v1 words) or null | `courts: 2`, `auth` (v2 words) or null |
| bot → PC | `GET /agent/jobs` (Glasgow Club's) | `courts: 1` | `courts: 2`, `auth` over the v2 words |
| PC → bot | `POST /agent/result` | `court`, as before | `court: "3 & 4"` (or `3`), `courts: [3, 4]`, `price` the total |
| PC → bot | `POST /agent/progress` (`stage: "bank"`) | `court` | `court: 3, courts: [3, 4]`, `price` the total |

What the bot checks of two courts: the shape of `courts` (400, as above); that a look showed the app
both courts free at that start (409 "That list is old…"); and, before it takes Pay from the app, that
your PC's note from the basket names both (else 409 "Your PC didn’t say both courts are in your
basket, so it isn’t asked to pay."). Your PC checks the rest: both in the basket, the basket's badge
reading exactly the number of courts it put in, the confirmed amount equal to the total, every amount
on the payment page either the total or one court's price as read at the basket (anything else and
nothing is typed or pressed), the Pay button saying exactly the total ("Pay £46.00"), the sealed code
bound to these courts, and, before "booked", every court new on the Bookings page. If only one shows
there, the ending is `"unsure"` or `"left"`, never `"booked"`, and the hold's lines say "I could not
see both courts as new bookings on your Bookings page".

Telegram: a hold of two courts can only be asked for from the app (Telegram's Hold button holds one);
once it is going, its card in Telegram (a Hold tap there brings it) reads "… · Courts 3 & 4", as do
the notes ("Booked · Gorbals courts 3 & 4") and the card of a booking of two from the midnight run
("Booked · Courts 3 & 4"). `/plan` names an entry of two "· 2 courts".

**Every side keeps the old single-court shapes.** A request, note, job or result without `courts` is
for one court, `court`, exactly as before 2.11; a weekly booking or one-off date of one court is kept,
backed up and signed exactly as before. Deploy in this order:

1. **The PC's booker** (2.11), first. It takes the bot's old messages (no `courts`) as before, and a
   job's `courts` when it comes.
2. **The bot** (this, 2.11). Until it is deployed the app cannot ask for two courts. A PC whose booker
   is older than 2.11 is safe with it: handed a hold of two, it holds the first court alone and its
   notes name that one, so the bot does not take Pay from the app for it (above); handed a job of two
   courts, it checks the v2 signature as v1 words, which fails, so it takes no court.
3. **The app** (an over-the-air update), last. An app older than 2.11 never sends `courts`, shows a
   result's `court: "3 & 4"` as it is, and ignores the fields it does not know.

## Notes and notifications

Whatever the bot tells the owner unprompted in Telegram (a court booked or not, trouble before a
booking, the PC not answering, how a hold ended) is also kept as a note, the last 30, and sent as a
notification to every linked phone that gave a push token (Expo's push service), best effort: a
failed push never delays or fails the Telegram message.

When a note is made, next to its Telegram message:

- A result, a warning, trouble before a booking and the heads-up: after Telegram has taken the
  message. If Telegram does not take it there is no note either, until it does (the PC sends a
  result again; a warning is tried again).
- "Your PC stayed awake" and a hold's ending: at the moment the bot sends the message or redraws
  the card, whether or not Telegram takes it. (A hold's card is tried again; that message is not.)
  A hold started from the app has no card: its note is all there is.

`id` is 10 hex characters. `title` (up to 120 characters) and `body` (up to 600) are one line each.
`ref` (2.10.4): the result the note is about, its id as in `results` (`"2026-11-24@16:00"`,
`"scotstoun/2026-11-25@18:00"`), so the app can open that court when the note is tapped (or, for a
`missed` one, that date); null for every other note, and for notes kept by a bot before 2.10.4. It is set on
`booked` and `missed` notes, and on a `hold` note when the hold ended booked. The note's notification
carries the same as `data: { ref }` (only when there is one), for the app to open when the
notification is tapped. The result may be gone by then (results are kept 60 days): the app then opens
nothing in particular.
They are cut by character, never through the middle of an emoji, and half an emoji left by a cut
made upstream (a reason from the PC, cut at 300 units for Telegram) arrives as U+FFFD. The same
goes for every sentence in the state.

| `kind` | When | `title` | `body` |
| --- | --- | --- | --- |
| `booked` | the PC booked a court (at its nightly run, or with Book now) | "Court 3 booked" ("Courts 3 & 4 booked" for two at once, 2.11) | "Thu 26 Nov · 19:00–21:00 · gate 2433" (or "… · gate code not shown"); at a park other than Kelvingrove the park comes first: "Queens Park · Fri 20 Nov · 18:00–19:00 · gate 4821"; at Glasgow Club "Gorbals · Wed 25 Nov · 18:00–19:00 · paid £46.00" |
| `missed` | it could not, or the weekly allowance kept a job from the nightly run | "Not booked" | "Tue 24 Nov · 19:00–21:00. No court free for the whole time." or "… It didn’t work: <reason>." (the park first, as above) |
| `warn` | ClubSpark turned your PC away, reading or booking a park | "ClubSpark turned your PC away" | "ClubSpark turned your PC away at 12:05, reading Maryhill Park's courts (ClubSpark showed a "Just a moment" page), which is how it treats a connection it is checking. Nothing more is read or booked at ClubSpark from the app until 14:05. Your nightly booking run uses the same connection: if ClubSpark still turns it away at 22:00, that run may not get through." (once for each pause; also sent in Telegram) |
| `warn` | trouble before a booking | "Trouble before the booking" | "<reason>. Trying again (2 of 3)." |
| `warn` | 20 minutes before, the PC does not answer | "Your PC is not answering" | "I sent it a wake-up at 21:40, ahead of tonight's booking, and it has not replied. Booking opens at 22:00 for Tue 24 Nov · 16:00–18:00." With no way to wake it from the bot: "It has not been in touch for over a day. Booking opens …", or, if the PC has never been in touch at all, "It has not been in touch yet. Booking opens …" |
| `warn` | 2 minutes before, the run has not started | "The booking run has not started" or "Your PC has not checked in" | the two lines of Telegram's warning |
| `warn` | 8 minutes after, no result | "No word from your PC" | "It started on Tue 24 Nov · 16:00–18:00 but has not said how it went. Check ClubSpark, and book by hand if it is not there." |
| `hold` | a hold ended, whoever started it | "Hold ended · Gorbals court 3", or "Booked · Gorbals court 3" ("… · Gorbals courts 3 & 4" for two, 2.11) | "Fri 20 Nov · 18:00–19:00. " and then the hold's last `lines` |
| `hold` | after a restart of the bot, the PC says of a hold the bot no longer follows that Pay was pressed (or may have been), or that it could not pay: once while it goes on, once when it ends | "Paying · Gorbals court 3", "Not paid by your PC · Gorbals court 3", then "Booked · …" or "Hold ended · …" ("… · a court your PC was holding" when the PC's note does not say which) | "Fri 20 Nov · 18:00–19:00. I am not following this hold any more (I was restarted while your PC had it), so its card does not change. This is what your PC says: …" |
| `info` | the PC started tonight's run | "Booking at 22:00" | "Tue 24 Nov · 16:00–18:00. Your PC is awake and signing in." |
| `info` | the PC would not go to sleep | "Your PC stayed awake" | "It did not go to sleep: <reason>." |

The notification is the note's `title` and `body`, with the default sound. Each goes to Expo
(`POST https://exp.host/--/api/v2/push/send`) once, with a 5 second limit; what goes wrong is said
in the bot's log and nowhere else, with anything shaped like a push token masked first. When Expo
answers that a token is not registered any more (`DeviceNotRegistered`), the bot forgets that
phone's push token: the phone stays linked, and gets notifications again once the app sends
`POST /app/push` with a token. A phone that has been unlinked is sent nothing.

## Known limits

- The bot passes on the card key that the PC's signed pings give it. A bot that lied about
  `pc.cardKey` could read whatever the app sealed for its own key instead, the card and its pay key
  included, and could then order payments with them. So the app keeps the first key it used and
  asks before using another, and the owner can compare fingerprints with the PC (`node book.js
  --card-key`). With the PC's real key, the bot can neither read the card nor order a payment of its
  own: Pay takes a code sealed with the pay key, and an automatic payment a booking signed with it,
  and only the app and the PC have that key.
- With automatic payments on, your PC pays at midnight for the Glasgow Club bookings the bot hands it,
  if the app signed them (2.10.1). A bot that is not what it should be can hand it only those: one
  you have since switched off or removed, too (a signature stays good while the card's pay key does),
  at its midnight or, for a one-off, once its day is open; each booking once at most, at most `GLASGOW_AUTO_PAY_MAX` (£30), and
  within the PC's daily limit (`GLASGOW_PAY_PER_DAY`, 2). It can also keep one from the PC.
  To stop them all, do it on the PC itself, where no bot can come between: set `GLASGOW_PAY_PER_DAY=0`
  in its `.env` (no automatic payment at all), or delete `vault\auto.json` (the kept security code).
  Forgetting the card, or switching automatic payments off in the app, works too when the bot is
  what it should be, but both orders travel through it.
- A bot that is not what it should be can still start holds, drop or delay what the app sends, or
  ask the PC to forget its card: nuisances, not payments.
- A restart of the bot loses `pc.cardKey` and `card` until the PC's next ping (within a minute while
  it is awake), and a card or a Pay waiting for the PC: send it again. While the PC pays, the bot
  follows a restart as it can: in a message and a note (see above).
- The card on the PC is protected by Windows for the user signed in there: a program running as that
  user can unlock it. While the PC types it in, the card and the code pass through the browser
  driver on the PC itself, as anything typed into Chrome does.
- Pay is one payment for one hold, tried once. If the PC could not pay, the owner pays at the PC or
  lets the court go; the app cannot try again for that hold.
- A restart of the bot during a hold loses the bot's handle on it: `state.hold` is null
  afterwards, `hold/order` answers "I am no longer following that hold…", and the one-at-a-time
  and six-an-hour counts start again. The PC still lets the court go by itself when its time is up.
  What looks showed the app, a waiting pairing code and the run's stage are lost with a restart too.
- A phone's token does not expire. It stops working when the phone unlinks itself, when
  `/app forget` is sent, or when the bot comes to answer to another chat.
- Telegram can only unlink every phone at once (`/app forget`). One phone can only be unlinked
  from that phone (`POST /app/unpair`).
- Someone who calls `/app/pair` without stopping sees the moment a code is waiting (the answer
  turns from `none` to `wrong`) and can spend it with five wrong tries, or, over two codes, use up
  the ten tries in ten minutes, so the owner's code is refused for up to ten minutes. They get no
  more guesses than the limits allow (five a code, ten in ten minutes: about one in a hundred
  thousand a code). The owner sends `/app` again later. Limits kept per address would end this.
- A phone linked while the bot answered to one chat is unlinked when it starts answering to
  another, even if that was a mistake in `TELEGRAM_CHAT_ID` put right later: link it again with
  `/app`. (Kept, it would go on getting the new chat's notifications.)
- Scheduling is at every venue since 2.10 (`api: 3`). The court `order` stays Kelvingrove's: at the
  other parks, and at Glasgow Club, the lowest-numbered court free is taken. That Glasgow Club opens
  each day 7 days ahead at 00:00 is as its site says now; the bot does not read it each night.
- Automatic payments keep the card's security code on your PC (protected by Windows, as the card is),
  which Pay from the app never does: anything running as your Windows user could ask Windows for both.
  Off, a new card or Forget deletes it. A card with a low limit keeps what could go wrong small.
- The weekly allowance takes a week to run Monday to Sunday (UK), by the day played: an
  assumption. It counts the bookings this bot made (kept 60 days), not any made by hand on ClubSpark,
  which it never sees.
- That all seven parks open each day 7 days ahead at 22:00, as Kelvingrove does, is assumed too;
  `clubspark.days` goes by it. A park that differs shows no free courts on a day it has not opened.
- A restart of the bot during Book now loses the bot's handle on it (`clubspark.book` is null
  afterwards). Your PC still asks for the go-ahead before it books, and a bot that does not know the
  booking does not give it, so nothing is booked after a restart; whatever was already booked is on
  ClubSpark, but the bot will not have the result. What looks showed the app, the reads counted
  and the two hours after ClubSpark turned your PC away are lost with a restart too (your PC keeps
  its own two hours, and says so on the next look).
- Your PC's link reads a park for a look before it asks for anything more: up to 40 seconds, most
  often 10 to 20. A hold, a card or an indoor look asked meanwhile waits for it, and a hold not
  collected within 25 seconds, or an indoor look not answered within 20, is given up (nothing was
  started: ask again). A look is allowed while a court is held, Pay included; it opens a Chrome
  window of its own, off the screen, beside the hold's.
- Going back to version 2.8 drops the results of bookings at the other six parks from the settings
  file: 2.8 does not know their ids (`queenspark/…`), so it leaves them out when it first saves.
  Moving forward to 2.9 again does not bring them back, and from then on those bookings no longer
  count towards their week, so the allowance could let a week go over. Kelvingrove's results, Book
  now ones included, keep their ids and survive. Going back is safest in a week with no park
  bookings; otherwise, keep count of that week by hand.
