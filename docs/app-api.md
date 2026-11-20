# The app's API

What the iPhone app (the Court_Booker_App repository) asks of the bot. It sits on the same small
HTTP server as the PC's endpoint (`lib/server.js`), under `/app/`. Everything the app can do, the
owner can already do in Telegram: the API adds no new powers, only another way in. Each request is
carried out by the function behind the Telegram command or button of the same name (`app.js`), so
the checks and the words are the same.

This file describes the API as built in version 2.8 (`api: 1`). The pure parts are in
`lib/appapi.js`, the push sender in `lib/push.js`, and the checks in `test/appapi.test.js`.

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
  answered `none` or `expired` at once and counts for nothing, so nobody can keep the owner out by
  asking. When a phone is linked the bot says so in Telegram. `/app forget` in Telegram unlinks
  every phone and cancels a code that is waiting.

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
for the answer: `GET /app/state` may wait its 25 seconds, and a look its 20.

What the app cannot overdo (each is spelt out where it belongs below): 12 looks that need a fresh
read in any minute, 60 one-off dates on the list, 4 waits open at once for one phone, and a hold
only for a court that a look showed the app free in the last 15 minutes.

## Reading

`GET /app/hello` → `{ ok: true, bot: "2.8", api: 1 }`. Nothing private.

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
  now, bot: "2.8",
  venue: { name: "Kelvingrove Park", short: "KP", first: 540, last: 1260, lengths: [1, 2],
           courts: [1,2,3,4,5,6], releaseMin: 1320, daysAhead: 7, maxAheadDays: 90 },
  paused: false,
  kept: "disk" | "variable" | "no",
  pc: { state: "awake" | "asleep" | "offline", linked, seenAt, line,      // line: the menu's own line about the PC, plain text
        canWake, wakeWhy, canSleep, sleepWhy, sleepAsked, wokeAt },
  release: null | { at, night, jobs: [ { id, date, start, end, from: "weekly" | "once" } ] },   // the next release that books something
  later:   [ the same, for the releases after it (up to 3) ],
  open:    [ { id, date, start, end } ],             // one-off dates already open, which the PC books at its next run
  plan:    [ { day: "mon".."sun", start, hours } ],  // every week; a day not listed is off
  once:    [ { id, date, start, hours, end, opensAt, open } ],            // one-off dates still ahead
  order:   [3, 6, 1, 2, 4, 5],
  results: [ { id, status: "booked" | "none" | "failed", date, start, end, court, gate, why, at, past } ],   // soonest upcoming first, then past ones newest first
  run:     null | { stage: "started" | "ready" | "trouble", at, why },    // tonight's run, as the PC reports it
  indoor:  { linked, days: 9, quietUntil, holdNo,                         // holdNo: why no hold can start now (plain text), or null
             centres: [ { key: "g", name: "Gorbals", site }, { key: "s", name: "Scotstoun", site } ] },
  hold:    null | hold,
  notes:   [ { id, at, kind: "booked" | "missed" | "warn" | "hold" | "info", title, body } ],   // newest first, the last 30
  devices: [ { id, name, at, seenAt, me } ],
}

hold = { id, startedBy: "app" | "telegram", centre, centreName, date, start, end, court, courtName,
         stage, live, ended: null | "released" | "booked" | …, price, until, heardAt,
         title, lines: [ … ],                // the Telegram card's own words, without markup
         can: { release, done },
         links: { basket, site, sheet } }
```

### The state, field by field

**`now`**: the bot's clock. **`bot`**: its version.

**`venue`**: Kelvingrove's fixed facts. `first` and `last` are the earliest start and the latest end
that Telegram's buttons offer (09:00 and 21:00); `lengths` the hours a booking can last; `releaseMin`
when a day opens (22:00 unless `RELEASE_TIME` says otherwise) and `daysAhead` how many days before
(7 unless `DAYS_AHEAD` does); `maxAheadDays` how far ahead a one-off may be (90).

**`paused`**: true after `/pause`. While it is true nothing is booked, so `release` is null and
`later` and `open` are empty; `plan` and `once` still list what is asked for.

**`kept`**: whether settings outlast a restart: `"disk"` (yes), `"variable"` (yes, from the
`COURT_SETTINGS` variable, though not the linked phones) or `"no"`.

**`pc`**

- `state`: `"awake"` (heard from in the last 3 minutes), `"asleep"`, or `"offline"` (not for over a
  day, or never). `linked`: whether a PC can reach the bot at all (always true over HTTP).
  `seenAt`: when it was last heard from, or null.
- `line`: one of "Your PC is awake." / "Your PC is asleep (last in touch today at 13:01). It wakes
  at 21:55 to book." / "Your PC has not been in touch since yesterday at 21:55. It may be off." /
  "Your PC has not been in touch yet." (null if no PC is linked).
- `canWake`, `wakeWhy`: whether `POST /app/pc/wake` would send a wake-up now, and if not, the
  sentence it would be refused with (null when it can): "Waking is not set up: add WAKE_MAC on
  Railway." / "I do not know your home address yet. Your PC must be in touch once first." / "Your
  PC is already awake." / "Sent a moment ago. Give it a minute." (for 30 seconds after a wake-up).
- `canSleep`, `sleepWhy`: the same for `POST /app/pc/sleep`: "Your PC is not linked to me." / "Your
  PC is not awake." / "Your PC books at 22:00, so it stays awake until then." (from 30 minutes
  before a release) / "Your PC is holding a court for you. Let it go first."
- `sleepAsked`: when sleep was asked for, while the PC has not collected the request yet (it has
  two minutes to; after that, or once collected, null). `wokeAt`: when the last wake-up was sent
  since the bot started, or null.

**`release`**: the next release that books something, or null (nothing asked for, or paused).
`at`: the moment it opens. `night`: the date of that night. `jobs`: what it books, by start time;
`id` is `YYYY-MM-DD@HH:MM` (the date and start played), the same id a result carries; `from` says
whether it comes from the weekly plan or a one-off (`"weekly"` when both ask for the same slot).
A release stays here until ten minutes after `at`, as the bot's own "Next booking" does.

**`later`**: up to three releases after that one, in the same shape.

**`open`**: one-off dates whose day is already open and which are not booked yet: the PC books them
at its next run. A one-off that repeats a weekly slot whose release was missed is one of these.
(In the ten minutes after a release, a one-off it opened is both here and still in `release.jobs`.)

**`plan`**: the weekly bookings, Monday first. **`order`**: the courts in the order they are tried.

**`once`**: the one-off dates whose start is still ahead (one that has started is left out, though
the bot keeps it until midnight). `id` as above; `end` is `start` plus the hours; `opensAt` is when
that day opens for booking; `open` is whether it has.

**`results`**: what the PC reported, kept for 60 days. First those dated today or later, soonest
first; then the past ones, newest first. `past`: the date is before today (UK).
`court`: the court as the PC gave it, a short string such as `"3"` (null unless booked).
`gate`: the gate code, a string (null if not booked, or if none was shown). `why`: null when
booked; "No court was free for the whole slot." for `none`; "It did not work: <the PC's reason>."
for `failed`. `at`: when the result came in.

**`run`**: how the PC's booking run stands, from half an hour before a release to an hour after
it. Null outside that time (a run started earlier in the day is not tonight's), while paused, once
every booking of that release has been reported on, and after a restart of the bot until the PC
says more. `stage`: `"started"` (it asked what to
book), `"ready"` (signed in to ClubSpark, waiting for the release) or `"trouble"` (an attempt
failed and it is trying again). `at`: when it said so. `why`: null, or for trouble the two lines of
Telegram's message, such as "ClubSpark did not load. Your PC is trying again (attempt 2 of 3)."

**`indoor`**

- `linked`: as `pc.linked`. `days`: how many days are on offer, today included (9).
- `quietUntil`: until when the PC leaves Glasgow Club's site alone (an hour), after it met a
  "checking your browser" page there or was told it asks too often; otherwise null.
- `holdNo`: the sentence `POST /app/hold` would be refused with now, or null when a hold can
  start. The sentences are listed under that request.
- `centres[].site`: a web address: that centre's booking sheet on Glasgow Club's own site, for
  today. (For another day use `look.sheet`, or change the date in `activityDate=`.)

**`hold`**: the hold being followed, or the last one. It stays after it has ended, with how it
ended, until another is started or the bot restarts (it is kept in memory only). One hold at a
time, whoever started it.

- `id`: 12 hex characters. `startedBy`: `"app"` or `"telegram"`. A hold started from the app has no
  card in Telegram unless a Hold button is tapped there while it is going; then that card follows it.
- `centre`: `"g"` or `"s"`; `centreName`: "Gorbals" or "Scotstoun". `date`, `start`, `end`: the
  hour held (`end` is `start` + 60). `court`: its number; `courtName`: "Court 3".
- `stage`: how far it has got: `"asked"` → `"signing-in"` → `"signed-in"` → `"adding"` → `"held"`
  (in the basket). It only moves forwards, and stays where it was when the hold ends.
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
- `price`: such as `"£23.00"`, once it is in the basket; null before, or if it did not read as a
  price. `until`: when the PC lets it go unpaid; null before it is in the basket.
  `heardAt`: when the PC last said anything about it (at first, when it was asked for).
- `title`: such as "Gorbals · Fri 20 Nov · 18:00–19:00 · Court 3". `lines`: what the card says
  under it, one sentence or more per line, in the words of Telegram's card for that moment.
- `can.release`: Telegram would show Stop or Let it go. `can.done`: it would show I have paid
  (only once the court is in the basket). Both are false once one has been asked, and once it is over.
- `links.basket`: the basket on Glasgow Club's site. `links.site`: the site's front page.
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
| `POST /app/once` | `/book` | `{ date, start, hours }`; `already: true` in the answer if it was there |
| `POST /app/once/remove` | `/cancel` | `{ date, start }` |
| `POST /app/plan` | `/set` | `{ day, start, hours }` |
| `POST /app/plan/remove` | `/off` | `{ day }` |
| `POST /app/order` | `/order` | `{ order: [six courts, each once] }` |
| `POST /app/pause` | `/pause`, `/resume` | `{ paused }` |
| `POST /app/pc/sleep` | Sleep my PC | `{}` |
| `POST /app/pc/wake` | Wake my PC | `{}` |
| `POST /app/indoor/look` | free indoor courts for a day | `{ centre: "g" | "s", date, fresh }` → `{ ok: true, look }` |
| `POST /app/hold` | Hold | `{ centre, date, start, court }` |
| `POST /app/hold/order` | Let it go / I have paid | `{ id, what: "release" | "done" }` |
| `POST /app/push` | | `{ token }`: this phone's Expo push token, or null to stop |

```
look = { centre, date, at, by: "pc" | "bot", note, sheet,
         slots: [ { start, end, courts: [ { n, name, price } ] } ] }      // free courts only, by start time
```

### Each request, and every `why` it can give

**`POST /app/once`** `{ date, start, hours }`. `hours` is 1 or 2. As `/book`, any start on the hour
or half hour that ends by midnight is taken; `venue.first` and `venue.last` are the hours to offer.
If that date and start are on the list already, nothing changes (not the hours either) and the
answer has `already: true`. The list holds 60 one-off dates at most, however they were asked for
(`/book` in Telegram is refused in the same words).

- 400 "A one-off booking needs a date (YYYY-MM-DD), a start in minutes after midnight, and hours (1 or 2)."
- 400 "Slots start on the hour. Try a time like 19:00."
- 400 "That slot runs past midnight. Try an earlier time."
- 400 "Tue 10 Nov at 19:00 has already passed." (that day and time)
- 400 "That is more than 90 days away. Try a nearer date."
- 409 "Your list already has 60 one-off dates, which is as many as I keep. Remove one first."

**`POST /app/once/remove`** `{ date, start }`. One that is not on the list is no error: the answer
is the state as it is.

- 400 "To remove a one-off booking, send its date (YYYY-MM-DD) and its start in minutes after midnight."

**`POST /app/plan`** `{ day, start, hours }`. Sets or changes that weekday.

- 400 "A weekly booking needs a day (mon to sun), a start in minutes after midnight, and hours (1 or 2)."
- 400 "Slots start on the hour. Try a time like 19:00."
- 400 "That slot runs past midnight. Try an earlier time."

**`POST /app/plan/remove`** `{ day }`. `day` may be `"all"`, as `/off all`. A day that was not set is
no error.

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
  Glasgow Club's name for it ("Tennis Hall Court 3"), and `price` is always null: the sheet
  carries no price (it is known once a court is held: `hold.price`).
- `note`: what Telegram's card says about that day, one sentence or more per line: "Free start
  times, as Glasgow Club showed it at 12:00. Each is one hour. Pick one." / "No court is free that
  day, as Glasgow Club showed it at 12:00." / "Glasgow Club's sheet lists no courts at all that
  day, as Glasgow Club showed it at 12:00. Open the sheet to see for yourself." / for a day (or
  hours) not open for booking yet, when it opens and what is free as it stands. Courts that are
  not open for booking yet are in the note only, never in `slots`.
- `sheet`: that centre's sheet for that day on Glasgow Club's site, to book and pay there by hand.

- 400 "A look needs a centre (g or s) and a date (YYYY-MM-DD)."
- 400 "There is no such centre: send g for Gorbals or s for Scotstoun."
- 400 "That day is no longer on offer. Pick again."
- 409 "That is 12 looks at Glasgow Club's sheet within a minute, which is as many as I ask for. Wait a minute, then look again."
- 409 "Your PC's nightly booking run is at 22:00, so I am asking nothing else of it until 22:10."
- 409 "Glasgow Club's site turns this server away, so your PC reads the free courts for me, and your PC is not awake. Wake it and try again, or open the sheet."
- 409 "Your PC did not answer in time, so I could not read Glasgow Club's free courts."
- 409 "Glasgow Club's site is checking visitors from your home connection just now, so your PC cannot read the free courts. It will not be asked again for an hour."
- 409 "Glasgow Club's site says it is being asked too often, so it will not be asked again for an hour."
- 409 "Glasgow Club's site did not answer in time."
- 409 "Your PC could not reach Glasgow Club's site." or "I could not reach Glasgow Club's site."
- 409 "Glasgow Club's site did not give me the free courts (<what went wrong>)." (among them "another look took its place")

**`POST /app/hold`** `{ centre, date, start, court }`. Your PC signs in to Glasgow Club, puts that
court in the basket and stops at the payment page; paying is the owner's. The answer's `state.hold`
is the new hold, at stage `"asked"`. The guards are the Hold button's own.

Telegram only offers Hold under a court that a sheet showed free. The app's equal: the centre,
date, start and court must be ones that a `POST /app/indoor/look` answered to the app (any linked
phone) in the last 15 minutes showed in its `slots`. What was shown is kept in memory only, so
after a restart of the bot the app must look again. `indoor.holdNo` does not cover this (it cannot
know which court will be asked for). The checks come in this order: the shape of the request, then
whether that time is on offer at all, then this, then the guards.

- 400 "A hold needs a centre (g or s), a date (YYYY-MM-DD), a start in minutes after midnight, and a court number."
- 400 "There is no such centre: send g for Gorbals or s for Scotstoun."
- 400 "That time is no longer on offer. Pick again." (a time that has passed, a day not among the nine, a court not from 1 to 20, a start that is not a five-minute step)
- 409 "That list is old. Read the day again, then hold a court." (no look in the last 15 minutes showed the app that court free then)
- 409, one of the `indoor.holdNo` sentences:
  - "Your PC is already holding a court."
  - "Your PC is not awake, and it is your PC that signs in to Glasgow Club and holds the court. Wake it and try again."
  - "Your PC's nightly booking run is at 22:00, so it holds nothing else from 21:25 to 22:15. The sheet below still opens."
  - "Glasgow Club's site was checking visitors from your home connection, so your PC is leaving it alone until 13:00."
  - "That is 6 holds within an hour, and each is a sign-in to Glasgow Club. The next can start at 13:00."
  - "Your PC is not linked to me, and it is your PC that signs in and holds the court." (not over HTTP)

**`POST /app/hold/order`** `{ id, what }`. `release` is Stop (before the basket) or Let it go;
`done` is I have paid. It works on a hold started from either side, as Telegram's buttons do. The
PC hears of it within a few seconds; until then `can.release` and `can.done` are false and the
hold's `lines` say what is being done. A `release` before the PC has collected the hold ends it
there and then (`ended: "stopped"`). A `done` before the court is in the basket is refused and
changes nothing, whether or not the PC has collected the hold yet: it never stops a hold.

- 400 "To act on a hold, send its id and what to do: release or done."
- 409 "I am no longer following that hold. If your PC still has it, it lets it go by itself when its time is up."
- 409 "That hold is over."
- 409 "It is not in your basket yet." (`done` at any stage before `"held"`)
- 409 "Already letting it go." or "Already checking."

**`POST /app/push`** `{ token }`. An Expo push token (`ExponentPushToken[…]` or `ExpoPushToken[…]`),
or null to stop. A token is kept for one phone only: given by a second, it moves to that one.

- 400 "That is not an Expo push token. Send one, or null to stop notifications."

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
They are cut by character, never through the middle of an emoji, and half an emoji left by a cut
made upstream (a reason from the PC, cut at 300 units for Telegram) arrives as U+FFFD. The same
goes for every sentence in the state.

| `kind` | When | `title` | `body` |
| --- | --- | --- | --- |
| `booked` | the PC booked a court | "Court 3 booked" | "Thu 26 Nov · 19:00–21:00 · gate 2433" (or "… · gate code not shown") |
| `missed` | it could not | "Not booked" | "Tue 24 Nov · 19:00–21:00. No court was free for the whole slot." or "… It did not work: <reason>." |
| `warn` | trouble before a booking | "Trouble before the booking" | "<reason>. Your PC is trying again (attempt 2 of 3)." |
| `warn` | 20 minutes before, the PC does not answer | "Your PC is not answering" | "I sent it a wake-up at 21:40, ahead of tonight's booking, and it has not replied. Booking opens at 22:00 for Tue 24 Nov · 16:00–18:00." With no way to wake it from the bot: "It has not been in touch for over a day. Booking opens …", or, if the PC has never been in touch at all, "It has not been in touch yet. Booking opens …" |
| `warn` | 2 minutes before, the run has not started | "The booking run has not started" or "Your PC has not checked in" | the two lines of Telegram's warning |
| `warn` | 8 minutes after, no result | "No word from your PC" | "It started on Tue 24 Nov · 16:00–18:00 but has not said how it went. Check ClubSpark, and book by hand if it is not there." |
| `hold` | a hold ended, whoever started it | "Hold ended · Gorbals court 3", or "Booked · Gorbals court 3" | "Fri 20 Nov · 18:00–19:00. " and then the hold's last `lines` |
| `info` | the PC started tonight's run | "Booking at 22:00" | "Tue 24 Nov · 16:00–18:00. Your PC is awake and signing in." |
| `info` | the PC would not go to sleep | "Your PC stayed awake" | "It did not go to sleep: <reason>." |

The notification is the note's `title` and `body`, with the default sound. Each goes to Expo
(`POST https://exp.host/--/api/v2/push/send`) once, with a 5 second limit; what goes wrong is said
in the bot's log and nowhere else, with anything shaped like a push token masked first. When Expo
answers that a token is not registered any more (`DeviceNotRegistered`), the bot forgets that
phone's push token: the phone stays linked, and gets notifications again once the app sends
`POST /app/push` with a token. A phone that has been unlinked is sent nothing.

## Known limits

- A restart of the bot during a hold loses the bot's handle on it: `state.hold` is null
  afterwards, `hold/order` answers "I am no longer following that hold…", and the one-at-a-time
  and six-an-hour counts start again. The PC still lets the court go by itself when its time is up.
  What looks showed the app, a waiting pairing code and the run's stage are lost with a restart too.
- A phone's token does not expire. It stops working when the phone unlinks itself, when
  `/app forget` is sent, or when the bot comes to answer to another chat.
- Telegram can only unlink every phone at once (`/app forget`). One phone can only be unlinked
  from that phone (`POST /app/unpair`).
