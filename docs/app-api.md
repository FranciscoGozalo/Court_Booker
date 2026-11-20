# The app's API

What the iPhone app (the Court_Booker_App repository) asks of the bot. It sits on the same small
HTTP server as the PC's endpoint (`lib/server.js`), under `/app/`. Everything the app can do, the
owner can already do in Telegram, with one exception: paying for a held court with the card your
PC keeps (see "Paying from the app"), which only the app can ask for, because only the app has the
card's security code. Each request is carried out by the function behind the Telegram command or
button of the same name (`app.js`), so the checks and the words are the same.

This file describes the API as built in version 2.9 (`api: 2`). `api: 2` adds the card and Pay:
`pc.cardKey`, `card`, `hold.can.pay`, the hold stages `"paying"` and `"approve"`, `POST /app/card`,
`POST /app/card/forget` and `what: "pay"` in `POST /app/hold/order`. Everything of `api: 1` is as it
was, but for the words of a hold in the basket (they no longer say to pay on the phone: signing in
to Glasgow Club on a phone does not show the basket your PC filled). The pure parts are in
`lib/appapi.js`, the push sender in `lib/push.js`, and the checks in `test/appapi.test.js` and
`test/pay.test.js`.

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
for the answer: `GET /app/state` may wait its 25 seconds, and a look its 20.

What the app cannot overdo (each is spelt out where it belongs below): 12 looks that need a fresh
read in any minute, 60 one-off dates on the list, 4 waits open at once for one phone, a hold
only for a court that a look showed the app free in the last 15 minutes, one card on its way to the
PC at a time, and one Pay for each hold.

## Reading

`GET /app/hello` → `{ ok: true, bot: "2.9", api: 2 }`. Nothing private.

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
  now, bot: "2.9",
  venue: { name: "Kelvingrove Park", short: "KP", first: 540, last: 1260, lengths: [1, 2],
           courts: [1,2,3,4,5,6], releaseMin: 1320, daysAhead: 7, maxAheadDays: 90 },
  paused: false,
  kept: "disk" | "variable" | "no",
  pc: { state: "awake" | "asleep" | "offline", linked, seenAt, line,      // line: the menu's own line about the PC, plain text
        canWake, wakeWhy, canSleep, sleepWhy, sleepAsked, wokeAt,
        cardKey },                                                      // the PC's key for sealing a card (base64), or null
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
  card:    null | { brand, last4, expMonth, expYear, pending, forgetting, why },   // the card your PC keeps, for Pay
  hold:    null | hold,
  notes:   [ { id, at, kind: "booked" | "missed" | "warn" | "hold" | "info", title, body } ],   // newest first, the last 30
  devices: [ { id, name, at, seenAt, me } ],
}

hold = { id, startedBy: "app" | "telegram", centre, centreName, date, start, end, court, courtName,
         stage, live, ended: null | "released" | "booked" | …, price, until, heardAt,
         title, lines: [ … ],                // the Telegram card's own words, without markup
         can: { release, done, pay },
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
- `cardKey`: your PC's key for sealing a card or a security code to it: standard base64 (44
  characters) of a 32-byte X25519 public key, made once on the PC, whose secret half never leaves
  it. As the PC's last ping gave it; null until a ping has, since the bot started (a PC whose
  booker is older than 2.9 never does). See "Paying from the app".

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

**`card`**: the card your PC keeps for paying from the app, as the PC's pings say (the bot keeps
none of it across a restart: the PC's next ping, within a minute while it is awake, says it again).
Null when the PC keeps no card as far as the bot knows, none is on its way and there is nothing to say.

- `brand`: "Visa", "Mastercard", "American Express", "Maestro", "Discover", "Diners Club", "JCB"
  or "Card". `last4`: the last four digits, a string. `expMonth` (1 to 12) and `expYear` (four
  digits). All four are null while the PC keeps no card (`pending` or `why` is then what there is).
  Nothing more of the card ever reaches the bot.
- `pending`: true from `POST /app/card` until the PC has said how that card went (it collects it
  with its next ping, within seconds while it is awake, and answers on the ping after), or two
  minutes have gone. The card shown meanwhile is the one kept before.
- `forgetting`: true from `POST /app/card/forget` until the PC has said how that went.
- `why`: why the last card (or forget) did not go through, or null. One of:
  - "Your PC did not keep that card: <the PC's reason>." The PC's reasons: "the card number does
    not pass the check every card number passes (a digit may be wrong)", "the card number should be
    12 to 19 digits", "the card number is missing", "the expiry month should be 1 to 12", "the
    expiry year should be four digits", "the card has expired", "the expiry is more than 20 years
    away, which I take for a slip", "the name on the card should be at most 60 characters", "it
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
- `centre`: `"g"` or `"s"`; `centreName`: "Gorbals" or "Scotstoun". `date`, `start`, `end`: the
  hour held (`end` is `start` + 60). `court`: its number; `courtName`: "Court 3".
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
  page's Pay button as the PC read it. Null before, or if it did not read as a price. `until`: when
  the PC lets it go unpaid; null before it is in the basket. While it pays, `until` is when the PC
  stops waiting for the payment's answer (it moves on the PC's word: up to six minutes after the
  press, five after your bank asks for approval).
  `heardAt`: when the PC last said anything about it (at first, when it was asked for).
- `title`: such as "Gorbals · Fri 20 Nov · 18:00–19:00 · Court 3". `lines`: what the card says
  under it, one sentence or more per line, in the words of Telegram's card for that moment.
- `can.release`: Telegram would show Stop or Let it go. `can.done`: it would show I have paid
  (only once the court is in the basket). Both are false once one has been asked, once Pay has been
  asked for (while the order is on its way and while the PC pays), and once it is over.
- `can.pay`: `POST /app/hold/order` with `what: "pay"` and the right amount would be taken now:
  the same check, so it is false exactly when that request would be refused (but for the amount),
  and the refusal's sentence says why. Telegram has no Pay button.
- `lines` while paying (the card's words, as they stand):
  - in the basket, the PC able to pay: "Pay from the app: your PC pays £23.00 with the card it keeps
    (Visa ending 4242), once you confirm it there." then "Or pay in the Chrome window on your PC,
    then tap I have paid." and "Unpaid, your PC lets it go at 12:12." When it cannot: "Paying from
    the app is not on for this court: <the PC's reason>." then "Pay in the Chrome window on your PC,
    then tap I have paid." A PC with an older booker says nothing of paying, and neither line is there.
  - Pay asked for: "In your basket: £23.00 to pay." and "Telling your PC to pay £23.00, as you asked
    in the app…"; told, and no word from the PC for half a minute: "Your PC was told to pay and has
    not said how it went. Before you pay any other way, look at the Chrome window on your PC, under
    Bookings on Glasgow Club's site and in your banking app."
  - `"paying"`: "Paying £23.00: your PC is typing in the card it keeps and pressing Pay…"; once
    pressed: "Your PC pressed Pay £23.00; I heard so at 12:03. If your bank asks you to approve it,
    do that in your banking app." and "Waiting for Glasgow Club's answer…"; or, when Chrome gave the
    PC no answer to the press: "Your PC may have pressed Pay £23.00: <why>. I heard so at 12:03."
    and what to do then. What the payment page says after the press may follow: "The payment page
    says: “…”".
  - `"approve"`: "Approve the payment in your banking app. Your bank wants you to approve £23.00 to
    Glasgow Club before it pays." and "Your PC pressed Pay and is waiting for the answer until 12:09."
  - back in the basket after Pay: "Your PC could not pay: <the PC's reason>. Pay was not pressed, so
    nothing was paid." (it does not try again for this court), or "Not paid from the app: <why>.
    Nothing was pressed, so you can ask again there." (the order never reached the PC).
  - how it ended after a press (`ended` as before): "Booked and paid. Your PC pressed Pay, and the
    court is on your Bookings page at Glasgow Club now; it was not before."; "Your PC pressed Pay,
    but the payment did not go through: …" (with what the payment page said); "Your PC pressed
    Pay, and then your bank asked for a code to be typed into the payment page. Your PC never types
    or passes on such a code, so it stopped there: the payment was not finished." (`"failed"`);
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
| `POST /app/hold/order` | Let it go / I have paid; Pay (app only) | `{ id, what: "release" | "done" }`, or `{ id, what: "pay", amount, sealed }` |
| `POST /app/card` | (app only) | `{ sealed }`: a card, sealed for `pc.cardKey` |
| `POST /app/card/forget` | (app only) | `{}` |
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
`done` is I have paid (`pay` is under "Paying from the app"). It works on a hold started from either side, as Telegram's buttons do. The
PC hears of it within a few seconds; until then `can.release` and `can.done` are false and the
hold's `lines` say what is being done. A `release` before the PC has collected the hold ends it
there and then (`ended: "stopped"`). A `done` before the court is in the basket is refused and
changes nothing, whether or not the PC has collected the hold yet: it never stops a hold.

- 400 "To act on a hold, send its id and what to do: release, done or pay."
- 409 "I am no longer following that hold. If your PC still has it, it lets it go by itself when its time is up."
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
code only ever comes from the app; its card says "Pay from the app" where the app can pay.

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

- The card: `{ number, expMonth, expYear, name }`. `number`: a string of 12 to 19 digits (spaces and
  dashes are ignored) that passes the Luhn check. `expMonth`: 1 to 12 (a number; "01" is taken too).
  `expYear`: four digits (two are taken as 20YY). The card must not have expired (it is good to the
  end of its month), and must expire within 20 years. `name`: the name on the card, up to 60
  characters, or left out. There is no security code in it: the PC never keeps one.
- The security code, for one payment: `{ cvc, id, amount }`. `cvc`: 3 or 4 digits, as a string.
  `id`: the hold's `id`. `amount`: the amount the owner confirmed, exactly as in the order
  (`"£23.00"`). The PC refuses a code sealed for another hold or another amount: a box kept by
  anyone on the way is of no use for any other payment.

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
your PC keeps. `amount`: the price the owner confirmed, which must be `hold.price` exactly. `sealed`:
the security code, sealed as above. The answer is the state: the hold's lines say the PC is being
told. The order waits for the PC's next note about the hold (one comes every few seconds), half a
minute at most, and goes with the answer to it, once; the sealed code is not kept after that. The PC
says `"paying"` before it types a key. If its next note is from the basket instead, the order did
not reach it: nothing was pressed, and Pay may be asked for again. The checks come in this order:

- 400 "To act on a hold, send its id and what to do: release, done or pay."
- 400 "To pay, send the hold's id, what: "pay", the amount you confirmed (such as "£23.00") and the sealed security code."
- 400 "That is not a sealed box I can pass on: it must be standard base64, at most 1024 characters, of a key, a nonce and the box."
- 409 "I am no longer following that hold. If your PC still has it, it lets it go by itself when its time is up."
- 409 "That hold is over."
- 409 "Your PC is paying for it already." (a second Pay while it pays, or after the press)
- 409 "Your PC has been told to pay for it already." (a second Pay while the order is on its way)
- 409 "Your PC tried to pay for it once and could not, so it will not try again. Pay at your PC, or let it go."
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
- 409 "Your PC could not read the price, so it cannot pay for this court."
- 409 "I have not heard from your PC for over a minute, so I am not asking it to pay."
- 409 "Too little of the hold's time is left to pay for it from here. Pay at your PC, or let it go." (under 30 seconds of `until`)
- 409 "The price is £23.00, not £25.00. Look at it again before you pay." (`amount` is not `hold.price`)

### What the PC does

1. It opens the code (sealed for this hold and this amount), unlocks the card it keeps, and checks
   the payment page: one Pay button reading exactly "Pay " and the amount, and the payment
   provider's three card boxes (card number, expiry, security code). If anything is not as it should
   be it types nothing and says why: the hold stays `"held"`, and its lines say "Your PC could not pay: …".
2. `"paying"`: it types the card and the code into the three boxes and reads each back, notes the
   payment for its daily limit (`GLASGOW_PAY_PER_DAY` on the PC, two unless set), and presses Pay,
   once. Stopped before the press, it goes back to `"held"`, unpaid.
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
| `hold` | after a restart of the bot, the PC says of a hold the bot no longer follows that Pay was pressed (or may have been), or that it could not pay: once while it goes on, once when it ends | "Paying · Gorbals court 3", "Not paid · Gorbals court 3", then "Booked · …" or "Hold ended · …" ("… · a court your PC was holding" when the PC's note does not say which) | "Fri 20 Nov · 18:00–19:00. I am not following this hold any more (I was restarted while your PC had it), so its card does not change. This is what your PC says: …" |
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
  `pc.cardKey` could read a card sealed for its own key: so the app keeps the first key it used and
  asks before using another, and the owner can compare fingerprints with the PC (`node book.js
  --card-key`). It could not use a security code for a payment other than the one it was sealed for.
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
