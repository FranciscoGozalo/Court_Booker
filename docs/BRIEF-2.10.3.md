# Brief: bot 2.10.3 (paid holds as bookings, short texts)

You're a cloud session on this repository: the Court Booker Telegram bot, Node. It also serves the Court Broker iPhone app's API. The owner moved this work to the cloud so that their PC can sleep.

## Ground rules
- **Branch:** `feat/2.10.3` (this brief is on it). `main` (a260dfa) is live as 2.10.1 on Railway, which deploys `main` on every push.
- Work on `feat/2.10.3`, push it, and open a PR to `main`.
- **Never push to or merge into `main` without the owner's explicit yes in this session.** A yes given elsewhere or earlier doesn't count. When the work is ready, ask them in one short paragraph.
- **Commit with** `git -c user.name="Francisco Gozalo" -c user.email=320681116+FranciscoGozalo@users.noreply.github.com commit`, each message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Context
- **The system:** a home PC books tennis courts in Glasgow. Glasgow Life parks are booked at 22:00, free, with gate codes. Glasgow Club courts (Gorbals, Scotstoun indoor and outdoor) are caught at midnight and paid automatically, or held and paid from the app.
- **The PC's booker:** live at 2.10.2. It can pay for a held court with the security code it keeps for automatic payments.
- **The app:** it's getting a calendar of the owner's *actual* bookings, built in another cloud session. That calendar needs this bot change.

## 1. Record a court held and paid from the app as a booking
**Today:** a Glasgow Club hold that ends booked only makes a note: `note('hold', 'Booked · …')`. See `app.js` around lines 532–620 and 861, `holdFromAgent`, and `HOLD_ENDS`. So the app's `results` never show it. See `cleanResult` (around line 90), `keepResult` (around line 1364), and the `results` section of `docs/app-api.md`.

**Example:** the owner held and paid Scotstoun outdoor, Wed 25 Nov 2026, 18:00–19:00, court 1, £6.00, and it appears in no list of bookings.

**Make a hold that ends `booked` also keep a result**, through the same path the PC's runs use, but without a second card, note or push (the hold already told the owner). The result needs:
- **The same id scheme** as Glasgow Club results from the midnight run for the same venue, type, date and start. Find it in the jobs code (`jobsFor`, `W.*`). Then a weekly booking for that slot isn't booked again, and a later result for that id doesn't duplicate it.
- **The fields:** `venue` (gorbals or scotstoun, from the hold's centre key g / s / o), `type` (indoor or outdoor), `date`, `start`, `end`, `court` (a string), `price`, `paid: true`, `gate: null`, `status: 'booked'`, and `why: null`.

Also:
- A hold booked after "I have paid" (the owner paid in Chrome on the PC) counts too, with `paid: true`.
- Holds that end any other way record nothing.
- Check that the allowance, weekly and `W.overIfPlanned` code treat it sensibly: Glasgow Club courts aren't part of the parks' allowance.
- Add tests next to the existing hold tests.

## 2. Short, direct texts
The owner wants every visible text "polished and direct, Apple UI/UX first, as little extra explanation as possible". The app's own wording was just rewritten that way. Shorten the bot's texts that reach the app's state (and Telegram), keeping every fact (amounts, times, courts, what to do):

| Now | New |
|---|---|
| "In your basket: £29.00 to pay. Your PC signed in as you and put it there at 19:43." | "£29.00 to pay. In your basket since 19:43." |
| "Pay from the app: your PC pays £29.00 with the card it keeps (Visa ending 4242), once you confirm it there. Or pay in the Chrome window on your PC, then tap I have paid." | "Pay here, or in Chrome on your PC and tap I Have Paid." |
| "Unpaid at 19:55, your PC lets it go." | "Let go at 19:55 if unpaid." |
| "Let go: your PC took the court out of your basket, so it was not paid for." | "Let go. Not paid." |
| "Free start times, as Glasgow Club showed it at 19:45. Each is one hour. Pick one." (Glasgow Club read note) | drop it, or null if the app tolerates that (it already shows "Updated 19:45") |
| "Your PC is asleep (last in touch today at 19:05). It wakes at 21:55 to book." (`pc.line`) | "Asleep · wakes at 21:55" |
| "Your PC has not been in touch since yesterday at 13:45. It may be off." (`pc.line`, offline) | "Last seen yesterday at 13:45" |
| "Your PC has not been in touch, so the bot does not know where to send the wake-up." | "Can’t wake your PC: it hasn’t been in touch." |
| "It is asleep already." / "Your PC is not answering." | "Already asleep." / "Your PC isn’t answering." |
| "No court was free for the whole slot." | "No court free for the whole time." (keep the result's `why` and its note consistent) |
| "Your PC's nightly booking run is at 22:00, so ClubSpark is not read from 21:00 to 22:30, to leave the connection quiet before it." | "Not available 21:00–22:30, around the nightly booking." |

- Look for other long texts of this kind that reach the app: `notes`, `pc`, `hold.lines`, `run.why`, `book.line`, look notes, and `why` strings in API answers. Tighten them the same way.
- Don't change payment logic, or the meaning of the safety wording after an uncertain payment ("maybe").
- Use ’ where the tests and Telegram's HTML allow it.

## 3. Docs and version
- **`docs/app-api.md`:** the hold `pay` order may carry, sealed, `{ cvc, id, amount, payKey, centre, date, start, court }`. Since the PC's 2.10.2 it may instead carry the same without `cvc` and with `use: 'kept'`, meaning pay with the code the PC keeps for automatic payments. The bot passes either on unopened. Paid holds now appear in `results`.
- **Version:** bump to 2.10.3 wherever it lives (`VERSION`, `package.json`). Keep the api level unless a field changed shape.

## Done means
- `npm test` is all green, with the expected strings updated where you changed them on purpose.
- The PR is open, listing old → new for each text and the test results.
- You've asked the owner for the yes to merge and deploy. Nothing is merged without it.
