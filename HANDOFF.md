# Hand-over from the local PC session, 25 Nov 2026

From the Claude session on the owner's PC to the cloud session
"Court Booker app tasks", at its request of 25 Nov about 05:20 (UK). From here the code is written in the cloud and
the PC only deploys.

Everything named below is pushed. Nothing here was pushed to `main` after the hand-over request.

## What is live now

| Part | Version | Commit | Since |
|---|---|---|---|
| PC booker (the live folder on the PC, repo kelvingrove-court-booker, `main`) | 2.11.0 | 138af8c | 21 Nov 19:23 |
| Bot (Court_Booker `main`, Railway) | 2.11.2 | b4da2a7 | 21 Nov 22:38 |
| App, runtime 1.1.0 (build 2) | update group a78c3f7f | Court_Booker_App `main` 5ffbbde | 25 Nov 05:05 |
| App, runtime 1.2.0 (build 5, widgets) | embedded | `release/1.2.0` 09960f8 | built 21 Nov 22:05 |

- **Build 1.2.0 (5):** the EAS build finished and its TestFlight submission was scheduled. Nobody has confirmed it
  arrived in TestFlight or that the owner installed it. Ask.
- **Two runtimes are in the field.** An over-the-air update reaches only its own runtime (policy `appVersion`).
  - `main` is 1.1.0.
  - `release/1.2.0` is 1.2.0 with the native widget config.
  - It has everything `main` had at f44557f. It lacks only 5ffbbde, a walk-through script fix with no app code.
  - Any app change must be published once per runtime still in use: from `main` for 1.1.0, and from `release/1.2.0`
    (after merging the change in) for 1.2.0.

## Branches pushed in this hand-over

| Repo | Branch | Commit | What it is |
|---|---|---|---|
| Court_Booker_App | `release/one-book` | da3b577 | Book now merged onto `main` 5ffbbde, conflicts resolved, walk-through fixed. **The one to publish.** |
| Court_Booker_App | `feat/one-book` | 13ebff7 | Book now's app part as built (on 48e9e10) |
| Court_Booker_App | `feat/widget-refresh` | a943797 | Widgets kept fresh with the app closed (on `release/1.2.0`). Has open findings, see below |
| Court_Booker | `feat/one-book` | cfb905a | Bot 2.11.3, Book now (on live b4da2a7; fast-forwards `main`) |
| Court_Booker | `feat/widget-refresh` | 163d249 | Bot: booking pushes wake the app (on b4da2a7). Not version-bumped |
| Court_Booker | `handoff/local-2026-11-25` | this branch | This file. The rehearsal scripts and the specs stay on the PC (the scripts carry test card numbers) |
| Court_Booker | `wip/bot-extras` | 07d4f74 | Old unfinished "extras" work (a calendar, on 2.4) that sat uncommitted in the bot's code folder on the PC. Never deployed; deploy only on the owner's word |
| kelvingrove-court-booker | `feat/one-book` | cc02914 | PC 2.11.3, Book now (on 092f99b) |
| kelvingrove-court-booker | `feat/2.11-courts` | 092f99b | Live 138af8c plus tests and a README line only (no code) |
| kelvingrove-court-booker | `wip/pc-tools` | 9d40317 | Two diagnostic tools that were untracked in the live folder (`tools/glasgow-club-check.js`, `tools/glasgow-club-record.js`). They are still untracked there too |

Already on GitHub before this: `main` of all three, `release/1.2.0`, `feat/two-courts`, `feat/ui-polish`,
`feat/2.11-courts` (bot).

## Remaining plan, in order

### 1. Book now at Glasgow Club ("one Book flow", 2.11.3). Built, not deployed.
The owner's rule (21 Nov): the app looks and behaves the same at every venue; the backend handles the operator; payment
is the only difference. On an open day at Glasgow Club the button is the parks' "Book Court N · HH:MM–HH:MM"; one Face
ID signs a one-off entry; the PC books exactly those courts and pays at once with the midnight run's code, after the
bot's explicit go. Spec with the critic's binding corrections: `one-book-spec.md` (on the PC).

**Checked on 25 Nov (this PC):**
- PC `feat/one-book`: `npm test` 380/380.
- Bot `feat/one-book`: `npm test` 350/350, twice.
- App `release/one-book`: `npm test` 125/125; `npx expo export --platform ios` builds.
- `one-book-rehearsal.cjs` (real bot and PC code, stand-in Glasgow Club and test card): 76 ok, 0 failed.
- Walk-through (`tools/e2e.mjs` in the app, run by `run-e2e-rel.sh bot-ob`): 20 of 20 on `iphone` and
  `duo-closed`, against a local copy of bot 2.11.3.

**Still to do before it goes live:**
1. Finish review round 2. Round 1 ran four lenses (money, parity, protocol, the night). Round 2 was cut off by the
   usage limit on 21 Nov. On 25 Nov two reviewers were started here (money; the night and mixed versions). Their
   results are in "Round-2 review" at the end of this file once they report; if that section is still empty, they
   had not finished.
2. Fix what round 2 confirms, rerun the suites, the rehearsal and the walk-through.
3. Deploy in this order, minutes apart: **PC, then bot, then app.** Each step is safe alone (see the spec's
   mixed-versions table: every mix falls back to Hold or ends "nothing booked").
   - **PC:** merge `feat/one-book` into kelvingrove-court-booker `main`. On the PC: `git pull` in the live folder,
     `npm ci` only if `package-lock.json` changed (it did not in cc02914), then restart the Windows task
     "ClubSpark PC link". Never between 21:25 and 00:30. Rollback: `git reset --keep 138af8c`, restart the link.
   - **Bot:** fast-forward Court_Booker `main` to `feat/one-book`. Railway deploys by itself. Check
     `/app/hello` says 2.11.3 and the log shows "Your PC gave me its card key." Rollback: redeploy b4da2a7.
   - **App:** publish `release/one-book` for runtime 1.1.0, and the same change merged into `release/1.2.0` for
     runtime 1.2.0:
     `npx --yes eas-cli@27.11.0 update --channel production --environment production --platform ios --message "…" --non-interactive`
4. The owner's standing rule: **ask before each deploy to the live bot** ("a go-ahead from earlier in the day does
   not count").

**Round-1 findings**

| Status | Sev | Part | Finding |
|---|---|---|---|
| fixed (13ebff7) | medium | app | Cancel at the confirm showed a red "Cancelled." toast and a spinner; a park's Cancel does nothing |
| fixed (cfb905a) | medium | bot | A second Book now ending at the same hour got no Telegram card, note or push, even when Pay may have been pressed |
| fixed (cfb905a) | medium | bot | Book now's refusal replaced the midnight run's "Pay was pressed" result with "Nothing was paid" |
| refuted | medium | bot | The bot never answers stop to a late "starting" (the PC cannot pay without the go, and gives the courts back) |
| open | low | pc | Book now carries on when the bot says it does not know the order (no go, so nothing is paid) |
| open | low | bot | A late "starting" for a booking the bot already ended gets no stop: the PC signs in and takes the courts, then gives them back |
| open | low | bot | After a tried payment, Book keeps offering the slot, asks Face ID, then fails; the app offers no way round |
| open | low | bot | `.env` internals and wrong advice in iPhone toasts and results ("DRY_RUN is on in .env…") |
| open | low | bot | After the bot says stop, its own words replace the PC's result, including that the court may still be in the basket |
| open | low | bot | "Approve £23.00 in your bank's app." stays after the owner approved, until the PC's result comes |
| open | low | bot | Guard 7 does not cover the midnight run: Book now is accepted after 00:30 while it may still be paying |
| open | low | pc | The link reads `logs/glasgow-pay.json` every minute; on Windows that might make the midnight run's write-and-rename fail (EPERM). Worth a retry on the write. The round-2 "night" reviewer was asked to assess this |

### 2. Widgets kept fresh with the app closed. Built, three findings open, needs a new native build.
Branches: app `feat/widget-refresh` a943797, bot `feat/widget-refresh` 163d249. A background task
(expo-background-task) and the bot's booking pushes with `_contentAvailable` each fetch the state once and rewrite
the widgets. Tests: app 139/139, bot 331/331. The fix round and the final check never ran (usage limit).

| Status | Sev | Finding |
|---|---|---|
| **open** | **high** | In SDK 58, React Native starts only from the scene delegate. When iOS launches the app in the background from cold (not in memory), no scene connects, so no JS runs: the task never runs and the push's completion handler is never called. The refresh works only while the app is still suspended in memory. A real fix is native (start React Native headless on a background launch) and could not be tested from Windows |
| open | medium | If a background launch does draw the root, `card.js`'s module-level subscription reads its Keychain item while the phone is locked, fails, and latches `nextHeld = false` for that process, so a new card's pay key is not adopted until the app is killed. Fix: defer all of `boot()` (not only the live loop) until the app is in view |
| open | medium | The same, from the other reviewer |

- **Needs a native build:** yes (`UIBackgroundModes`, the background-task identifier, expo-notifications'
  `enableBackgroundRemoteNotifications`). It cannot ship as an update.
- **Recommendation:** do not spend a build on it as it stands. Either solve the cold-launch problem natively and
  test on a device, or ship it knowingly as "fresh while the app is still in memory" with the medium fixed.
- **The bot half** is harmless but pointless until an app build has the background mode. Do not deploy it before.
- Until then the widgets refresh when the app is opened, and say "Open Court Broker to see your courts" when a
  booking may have happened since.

### 3. Other things the owner asked for that are not done
- **Live Lock Screen card updated by push** (starts and updates while the app is closed): needs an APNs `.p8` key
  that only he can create. Today the card starts only while the app is in front.
- **Two courts at once at the parks:** not built. Courts 1 | 2 is Glasgow Club only; whether the parks' pass allows
  two at once was never checked. He was told this on 21 Nov and did not answer.
- **The Hold sheet:** kept as the fallback for an older bot or PC. Retire it once Book now has run for real.
- **Confirm build 5 in TestFlight**, and the widgets on his phone (see "What is live now").
- **Merge `release/1.2.0` into `main`** once he is on build 5, and stop publishing for 1.1.0.

### 4. Known lows left open
- **Scheduling at Glasgow Club (2.11.2, live):**
  - A one-off covered by a weekly booking shows its own courts, but the PC books the weekly booking's.
  - A Glasgow Club date whose midnight has passed stays "Open now" though nothing will book it.
  - `later` carries courts and names but never a price (the sheet has none), so Schedule rows show no price.
  - Between 21:55 and midnight, Schedule says "Schedule Again" on a date Book won't let you change.
  - More than two Glasgow Club bookings for one day all read "Scheduled", but the PC pays for two a night.
- **Header and glass:** `ui-remaining.md` (on the PC), plus two lows from the last round (the page title's
  hand-over dips for a few points of scroll on the open Duo; a faint rim of List | Month under the gear at the end
  of the list).

## Things that are easy to get wrong
- **The PC takes its Glasgow Club midnight list once, at 21:55** (`book.js` `decideJobs`). Anything scheduled or
  changed after 21:55 for the day opening at that midnight is not booked. The app says so.
- **Never run a signed-in flow** against ClubSpark or Glasgow Club from a Claude session: it types the owner's
  password. Never read or print `.env`, passwords, card data or `agent-key.pem`. Never type card details or press
  Pay on the real site. Stand-ins with published test card numbers only. Never work around "checking your browser".
- **The bot's quiet window:** looks and Book now are refused 21:00–22:30 around the nightly run, so the
  walk-through and the two-courts rehearsal cannot pass then.
- **`tools/dev-bot.cjs` keeps its state between walk-throughs.** Restart it before each run, or later runs fail on
  leftovers (a paused bot, a slot already booked).
- **The walk-through must restart the app with `page.goto(START)`,** never `page.reload()`: after navigation the tab's
  address has lost `?bot=`, and a reload points the page at the live bot.
- **App commits** need the identity the app repo's own history uses (the PC's git has none set).
- **`eas` is not on PATH on the PC:** `npx --yes eas-cli@27.11.0 …` (in PowerShell, `npx.cmd`). The PC is signed in
  to Expo; Apple credentials for both targets (app and widget extension) are on EAS since 21 Nov,
  so builds run `--non-interactive`.
- **Treat a native build as scarce.** Ship JS as updates.

## The rehearsal scripts and specs
Kept on the PC only, in the local session's working folder and as local commits on this branch's name in the bot
repo there: `one-book-rehearsal.cjs`, `two-courts-rehearsal.cjs`, `run-e2e-rel.sh`, `run-e2e-2112.sh`,
`resolve-app-rel.cjs`, and the specs (`one-book-spec.md`, `schedule-glasgow-spec.md`, `two-courts-spec.md`,
`ui-remaining.md`). The rehearsals need checkouts named `bot-ob`, `pc-ob`, `app-ob`, `pc-211` and `bot-211` beside
them. Ask the PC session to run them.

## Round-2 review of Book now (25 Nov)

### The night and mixed versions: no high, no medium, three lows
- **The 21:55 run and its midnight payments are untouched.** Every new branch in `tools/glasgow-club-book.js` hangs on
  `job.now` / `goNow` / `named`, which a night job never has; `book.js` is unchanged and builds night jobs from a
  fixed field list. The midnight tests have no deleted lines and pass.
- **Shared state:** the daily press note is counted by UK date; paid-once ids are per slot; `hold-ids.json`,
  `hold-running.json` and `MAX_STARTS` are the link's only. A daytime Book now cannot block that night's midnight
  booking.
- **What stops a Book now while the 21:55 process is alive, on the PC itself:** `nightly()` in `lib/hold.js` (the
  clock 21:25–22:15, Windows saying the task is running, and a refusal until 00:55 when Windows cannot say). There is
  no shared lock; a night run started by hand outside the task would be seen only by the bot's guards. Same as for
  holds today.
- **Mixed versions:** every mix shows Hold or ends with nothing booked; none pays wrongly or hangs. New PC with the
  live bot was run for real: the ping with `glasgowBook` answers 200 and the field is ignored; the new route
  answers 404. The default handler is a 404, and an unknown id asking "paying" gets `{ ok: true, stop: true }`.

| Status | Sev | Where | Finding |
|---|---|---|---|
| open | low | PC `lib/link.js:95`, `lib/pay.js:133` | **Reproduced.** The link now reads `logs/glasgow-pay.json` on every ping. The note is written temp-then-rename, and on this PC `renameSync` fails with EPERM while another process has the target open. Odds are about 2–5 in a million per write, three writes per midnight booking. If it hits, no money moves but that booking is lost. **Fix before deploying:** retry the rename on EPERM/EBUSY/EACCES, or have the link skip the read from 21:25 to 00:55 |
| open | low | app `src/screens/AutoPaySheet.js:48` | The turn-off alert says "Glasgow Club courts won't be booked or paid from the app." That is false wherever Hold remains (an older bot or PC, a time outside the signed hours, a hold started in Telegram) |
| open | low | app `src/data/tabs.js:146-149`, bot `lib/glasgowbook.js:115` | When the PC says it cannot pay (the day's two payments used, or `GLASGOW_PAY_PER_DAY=0`), the app offers Book, which always refuses, and no Hold. Telegram's Hold still works. A consequence of the spec's decisions 7 and 9; decide whether the app should fall back to Hold then |

### Money: no high, ONE MEDIUM TO FIX BEFORE ANY DEPLOY, three lows

**Do not deploy Book now until the medium is fixed.**

| Status | Sev | Where | Finding |
|---|---|---|---|
| **open** | **medium** | PC `tools/glasgow-club-book.js` (`bookNowJob`), `lib/hold.js` (`readBookAsk`); bot `app.js` (state), `lib/appapi.js`; app `src/data/card.js` | **Book now is checked against the one-off words, the court numbers are not in what is signed, and nothing in it is fresh.** Bounded on the PC by the signed venue, type, date, hour and court count, the cap, one payment per slot, the daily limit and the nightly window. **Fix:** Book now gets its own signed words that name the court numbers and a minute stamp; the PC refuses once/weekly words for a `job.now`, refuses now-words at midnight, and refuses a stale stamp; the state serves a check value in place of `auth`. The cloud session reports this in hand on `fix/now-signature` |
| open | low | PC `tools/glasgow-club-book.js:750, :852, :1678` | Pay Automatically switched off during a run is honoured only by the bot's go: the code is read once at the start and `hasAuto()` is not looked at again before the first key. The same holds at midnight (before this change). Fix: check `vault.hasAuto()` in `beforeTyping` |
| open | low | PC `lib/hold.js:123` | The signature is passed as `--auth` on the tool's command line: readable by same-user processes and by command-line auditing. It is not in any log. Pass it by stdin or a file handle |
| open | low | PC `tools/glasgow-club-book.js:2027` | A paid Book now whose result cannot be posted (the bot restarting between the go and the result) is only written to hold.log: no card, no note, nothing on Courts. No second payment is possible (`paidBefore`). Fix: notify as `runClubs` does, or keep retrying the result for a few minutes |

**What the reviewer could not break (PC alone):** a payment without a valid signature over venue, type, date, start,
hours and court count; above the cap; twice for one slot (Book now twice, Book now and midnight either way, v1 then
v2, a new id, a link or bot restart, two phones); for one court of two; with DRY_RUN on or the daily limit at 0 or
used up; after a sleep or a stop. The midnight path is unchanged.

The reviewers' probe scripts stayed on the PC.
