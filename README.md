# Court booker

A small Telegram bot for Kelvingrove Park Tennis Courts. You tell it what you want to play, every week or on single dates, and it gets them booked. When each day opens for booking, your PC at home signs in to ClubSpark and books the first free court in your order. The bot then sends you a card with the court, the time and the **gate code**.

The work is split in two because ClubSpark sits behind Cloudflare, which turns cloud servers like Railway away:

- **The bot runs on Railway.** It is always online, keeps your requests, answers your messages and sends the cards.
- **The booker runs on your PC.** It is in the separate repository [kelvingrove-court-booker](https://github.com/FranciscoGozalo/kelvingrove-court-booker). A Windows task wakes the PC at 21:55, the booker asks this bot what to book, books it at 22:00 and reports back.

Your ClubSpark password stays on your PC. The bot never sees it and never touches ClubSpark.

It also finds free **courts at Gorbals and Scotstoun** (Glasgow Club: indoor, and at Scotstoun outdoor too), and can have your PC put one in your basket for you to pay for; see [Indoor courts](#indoor-courts-glasgow-club).

There is an **iPhone app** too, which does the same things as the Telegram chat, and can also have your PC pay for a court it holds; see [The iPhone app](#the-iphone-app).

From version 2.10 the app can also set weekly bookings and one-off dates at the other parks and at Glasgow Club. Your PC books them on its nightly run, and at Glasgow Club pays for them by itself if you switch automatic payments on; see [Weekly bookings at any venue](#weekly-bookings-at-any-venue-version-2101).

## What a booking night looks like

Kelvingrove opens each day 7 days ahead at 22:00. So a Thursday is booked on the Thursday before.

| UK time | What happens |
| --- | --- |
| 21:40 | The bot checks your PC is in touch. If it is asleep, the bot wakes it (see [Waking your PC](#waking-your-pc)). |
| 21:43 | Only if the PC did **not** answer that wake-up: **Your PC is not answering**, with a Wake button. Usually it restarted and is waiting for you to sign in to Windows, or it is switched off. |
| 21:55 | Your PC starts its booking run and asks the bot what to book. You get a card with the green "PC awake" dot: what it is about to book, and "Your PC is awake and signing in". Once it has signed in to ClubSpark the card changes to "Signed in. Waiting for 22:00." |
| 21:58 | Only if the booking run has **not** started: a warning, so you can book by hand. It says whether the PC itself is awake (then its task is the problem) or not in touch at all. |
| 22:00 | The PC books the first free court in your order for the whole slot. |
| 22:00:10 or so | A card on the "Court booked" banner: **Booked · Court 3**, the date and time, and the gate code. If nothing was free, a card on the "Not booked" banner saying why. |
| 22:08 | Only if the run started but **no result** came back: **No word from your PC**, so you can check ClubSpark. |

If the PC hits a problem before the booking (Chrome will not start, ClubSpark will not load), it tries again, up to three times, and you get **Trouble before the booking** with the reason while there are still minutes to spare.

A one-off date that is already open is booked on the PC's next run (21:55 that night), or straight away if you start the booker on the PC by hand.

With bookings at other venues (version 2.10, set in the app), 22:00 goes the same way: Kelvingrove's first, as above, then the other parks' in the same run. A night with a Glasgow Club booking goes on past midnight, when Glasgow Club opens its day; see [Weekly bookings at any venue](#weekly-bookings-at-any-venue-version-2101).

## Indoor courts (Glasgow Club)

**Book a date** on the menu first asks where: Kelvingrove Park, Gorbals (indoor), Scotstoun (indoor) or Scotstoun (outdoor: its own sheet on Glasgow Club's site, hourly from 08:00 to 18:00, from version 2.9.3; your PC reads and holds it once its booker is updated for it, and a booker not yet updated says so). For each of the three the bot shows a day's free start times, read from Glasgow Club's booking site as any visitor sees them, then which courts are free at the time you pick. Under them are a **Hold** button for each free court, and a button that opens that day's sheet on Glasgow Club's own page, where you can book and pay yourself.

**Hold** has your PC do the first half of the booking. It signs in to Glasgow Club with the login kept on the PC, puts that court in your basket, presses "Continue to payment" and stops there, with the payment page open in a Chrome window on the PC. The card in Telegram follows each step, then shows the price and two buttons: **I have paid** and **Let it go**. Signing in to Glasgow Club on your phone does not show that basket (it is kept in the browser that filled it), so the court is paid for on the PC: from the iPhone app, which has your PC pay with the card it keeps (below), or in the Chrome window on the PC itself, after which you tap **I have paid**. Unpaid, the PC takes the court out of the basket again after 12 minutes (it waits up to five more while your bank's own page is showing). It takes out only a court that is still in the basket, and it calls a court booked only when your Bookings page lists it more often than it did just after signing in; anything else is said as "I could not see it", with what the basket showed.

**Pay from the app** is the iPhone app's alone: Telegram has no Pay button. You type your card into the app once; the app seals it for your PC's own key (the PC makes that key once and keeps its secret half to itself, protected by Windows) and sends it here, and the bot, which cannot open it, hands it to your PC with the PC's next ping and keeps nothing of it, neither in its log nor on disk. The PC checks it and keeps it, protected by Windows; the app is shown only which card it is (Visa ending 4242, say), its expiry, and a short tag of the pay key it was kept with (version 2.9.1), so the app knows its own card. On a court in your basket, the app's Pay asks you to confirm the price with Face ID and for the card's security code, which the PC never keeps: it comes sealed with each payment, for that court and that amount only, with a pay key that only the app and your PC know (sent with the card), so nobody else, the bot included, can order such a payment; and your PC takes one order to pay for a hold at most. The bot checks that the court is in the basket, that the PC keeps a card and says it can pay for this court, and that the price is the one your PC read; it then hands the order to your PC with the PC's next note, a few seconds on, or drops it unsent after half a minute. Your PC checks that the payment page says that same amount, types the card in, presses Pay once and says how it goes: paying, then **approve** if your bank wants you to approve the payment in your banking app (the PC waits five minutes for that), then how it ended. If your bank asks for a code to be typed into the page, the PC stops there: it never types or passes on such a code. `docs/app-api.md` has the details, and the booker's README the PC's side.

After a press nothing is taken out of the basket, and the ending is "Booked and paid" only when your Bookings page shows the court as new. Every other ending after a press says that Pay was pressed, that whether the payment went through is not known here, and to look under Bookings on Glasgow Club's site and in your banking app: also when the Chrome window was closed, the PC went to sleep, its tool was stopped, or nothing more was heard. Sometimes the PC cannot tell whether its press landed (Chrome gave it no answer); it then says it **may have pressed Pay**, and everything goes on as if it had. And if the PC was told to pay and never said how that went, the ending says exactly that, and where to look. A hold card in Telegram follows all of it; after a press its buttons open a new card, so the card that says Pay was pressed stays in the chat, and such a hold is followed to its end even if you hold another court meanwhile. If the bot is restarted while the PC pays, the bot tells you in a message, and in the app's notes: once to say the PC is still waiting, and once to say how it ended.

A held court that ends booked (paid from the app, or in Chrome on the PC and then **I have paid**) is kept as a booking too, since version 2.10.3: the app's list of bookings shows it, as it would one the midnight run booked for the same venue, date and time, and under the same id, so a weekly booking or one-off for that slot is not booked again. It says nothing more than the hold's own card and note already did, and it counts toward no allowance.

Glasgow Club takes a card payment with each booking, and its own settings have saved cards and pay-by-link switched off (`GladstonePay_AllowMemberWallet` and `PayByLink_Enabled`, as read on 19 Nov 2026). Its site keeps a basket in the browser that filled it: signing in on your phone shows an empty basket (tried on 20 Nov 2026). So pay from the app or in the Chrome window on the PC, or let the court go and book from the sheet on your phone.

One court is held at a time and at most six holds are started in an hour. None is started from 35 minutes before the release time to 15 minutes after, every night, nor from 23:25 to 00:30 on a night your PC books at Glasgow Club; the PC itself refuses over the first stretch by its own clock, and whenever its nightly booking is running. The PC is not put to sleep while it holds a court. If Glasgow Club's site ever answers the PC with a "checking your browser" page, the hold stops there, and for an hour no hold is started and the PC is not asked to read the sheet either. While a court is held its card has no Menu button, so the card stays where its buttons are; tapping **Hold** on any other card brings it there.

Each day opens for booking a week ahead, at midnight. A day that has not opened yet is shown with the time it opens and what is free as it stands.

Glasgow Club's site turns cloud servers away with a "checking your browser" page, as ClubSpark does, so the bot on Railway cannot read the free courts itself. **Your PC reads them** while it is awake: the bot asks on the PC link's ping, the PC makes the two requests any visitor's browser makes (a visitor's session, then the day's sheet; never your login) and passes the sheet on. A day is read at most once a minute, and an answer usually takes a second or two.

If your PC is asleep, the card says so and offers **Wake my PC** (when waking is set up); the link to the sheet is there either way. From ten minutes before a Kelvingrove booking to ten minutes after, nothing is asked of the PC. If the site ever checks visitors from your home connection too, the PC says so and is not asked again for an hour. Nothing, on the bot or the PC, tries to get round such a check. `/status` says when the free courts were last read, and by which way.

## Commands

| Command | What it does |
| --- | --- |
| `/menu` | Buttons for everything below: book a date from a calendar, set weekly days, see and remove bookings, court order, pause, status. Each tap changes the same card. |
| `/set thu 19:00 2h` | Book Thursdays at 19:00 for two hours at Kelvingrove, every week. `1h` or `2h`. Also understands `7pm` and `19:00-21:00`. Weekly bookings at the other venues are set in the app. |
| `/off thu` | Stop Thursdays at Kelvingrove. `/off all` clears every weekly booking at Kelvingrove; those at other venues (set in the app) stay. |
| `/book 25 nov 19:00 2h` | Book one Kelvingrove date. `/book` alone asks where first. Also `25/11`, `wed` (the coming Wednesday), `tomorrow`, `2026-11-25`. The list holds 60 one-off dates at most. |
| `/cancel 2` | Remove one-off number 2 from `/plan`. `/cancel 25 nov` removes that date's. |
| `/gorbals`, `/scotstoun` | The free indoor courts at that centre (Scotstoun's outdoor courts are under **Book a date**): pick a day, then a start time, then **Hold** a court (your PC puts it in your basket, and you pay) or open Glasgow Club's page to book and pay yourself. See [Indoor courts](#indoor-courts-glasgow-club). |
| `/plan` | Your weekly and one-off bookings at every venue, how each stands, and the next booking run. |
| `/order 3 4 5 2 1 6` | Which courts to try first. |
| `/pause`, `/resume` | Stop and restart booking. |
| `/status` | Clock check, version, your PC's state and when it was last in touch, whether waking is ready, and whether settings are kept. |
| `/wake` | Wake your PC from sleep (the same as **Wake my PC** on the menu). See [Waking your PC](#waking-your-pc). |
| `/sleep` | Put your PC to sleep (the same as **Sleep my PC** on the menu, without the "are you sure?"). See [Sleeping your PC](#sleeping-your-pc). |
| `/app` | A code to link the iPhone app to the bot. `/app forget` unlinks every phone. See [The iPhone app](#the-iphone-app). |
| `/wide` | A trial: the menu with the banner as a large link preview, which Telegram may draw wider than a picture on a tablet. |
| `/backup` | Your settings as one line, for the `COURT_SETTINGS` variable. |
| `/id` | Your chat ID. |

## Set it up

### 1. The bot (Railway)

1. In Telegram, open **@BotFather**, send `/newbot`, and copy the token it gives you.
2. In Railway: **New Project**, **Deploy from GitHub repo**, pick **Court_Booker**. Under **Variables** add `TELEGRAM_BOT_TOKEN`.
3. Open your bot in Telegram and press **Start**. The first person to send `/start` becomes its owner. Add the chat ID it replies with as `TELEGRAM_CHAT_ID`.
4. **Make it remember:** create a **Volume** in the project, attach it to the service and mount it at `/data`. (Or send `/backup` and save the line as `COURT_SETTINGS`.)

### 2. Link your PC

1. In Railway, open the service, **Settings > Networking > Generate Domain**. You get an address like `https://court-booker-production.up.railway.app`.
2. Invent one long random line. Add it in Railway as `AGENT_TOKEN`. The log then says `Listening for your PC`.
3. On the PC, in the kelvingrove-court-booker folder, put the same two things in `.env`:

   ```
   BOT_URL=https://court-booker-production.up.railway.app
   AGENT_TOKEN=the-same-long-line
   ```

   From then on the PC books what the bot tells it, instead of `BOOK_DAYS`. See that repository's README for the rest of the PC setup.

## Your PC's dot

The menu card's banner says **Court Booker** with a dot for your PC: green **awake**, amber **asleep**, red **offline**. While you are signed in to Windows, the booker's "PC link" task tells the bot once a minute that the PC is awake (`node book.js --link`). When that stops for 3 minutes the PC counts as asleep; after a day and a half-hour without a word (so it missed its nightly run), as offline. The newest menu card changes its dot by itself when this changes.

## Waking your PC

While the dot is amber or red, the menu has a **Wake my PC** button (and there is `/wake`). It sends a Wake-on-LAN "magic packet" over the internet: six `FF` bytes and then your PC's network card address sixteen times, by UDP to your home's public address. Your router passes it on to the PC, and the sleeping network card wakes the PC. When the PC answers, the dot turns green by itself.

- **Where home is:** the address your PC's own signed pings come from (Railway's `X-Real-IP`). It is learned on the first ping and follows your home if your internet provider changes the address. Nothing is sent until the PC has been in touch once.
- **What it needs:**
  - On the PC, the network card allowed to wake it, with only magic packets (Windows, as administrator): `powercfg /deviceenablewake "<card name>"` and **Wake on Pattern Match** off in the card's advanced settings.
  - On the router, a fixed address for the PC (a DHCP reservation) and a port forward: UDP, an outside port of your choice (for example `40009`) to port `9` on the PC.
  - On Railway, `WAKE_MAC` (the card's address) and `WAKE_PORT` (the outside port).
- **What it can't do:** wake a PC that is shut down, or one behind a provider that shares one public address between many homes (then no port forward is possible). The packet carries no command and no data, and nothing on the PC listens on that port.

## Sleeping your PC

While the dot is green, the same place on the menu has **Sleep my PC** (and there is `/sleep`). The bot cannot reach into your PC, so it hands the request to the PC's next ping: the PC link's ping waits up to 50 seconds for an answer, so the request arrives within seconds of your tap. The PC then goes to ordinary sleep (not hibernate), and the dot turns amber straight away.

- **Never before a booking:** from 30 minutes before a release, the bot refuses, and the PC itself refuses while its nightly booking task is running.
- **Only when it can wake for the booking:** the PC sleeps only if its booking task (21:55 each night, 5 minutes before the 22:00 release) is there, switched on, set to wake the computer and due to run, and wake timers are allowed. Otherwise it stays awake and you get a message saying why.
- **Never late:** a request that no ping collects within 2 minutes is dropped, so the PC doesn't fall asleep the next time it wakes.
- Nothing open on the PC is closed. Wake it again with **Wake my PC**.

## The iPhone app

The app (the separate Court_Booker_App repository) is another way in to the same bot. It shows what the Telegram chat shows: your weekly and one-off bookings, the next booking run, what was booked and the gate codes, your PC's dot, the free indoor courts and a court being held. And it asks for the same things: book or remove a date, set a weekday, court order, pause, wake or sleep your PC, hold an indoor court. Each request is carried out by the same code as the Telegram command or button, with the same checks and the same words when the answer is no. **The app adds two powers**. One is paying for a court your PC holds, with the card your PC keeps (see **Pay from the app** above): Telegram cannot, since only the app has the card's security code. The other is Glasgow Life's parks, their free courts and a court booked now (below): a phone you link can have your PC book there at most 4 times an hour, only a court the app was shown free in the last 15 minutes, within the weekly allowance, and never one that costs money. Since version 2.10 it adds a third: weekly bookings and one-off dates at any venue, with automatic payments at Glasgow Club (below). Everything else the app does, you can already do in the chat.

- **Link a phone:** send `/app`. The bot answers with a six-digit code (and its own address, if the app asks where the bot is). Type the code into the app within 10 minutes. It works once, five wrong tries cancel it, and a new `/app` replaces it. The bot tells you in Telegram when a phone has been linked. Up to five phones can be linked.
- **Unlink:** `/app forget` unlinks every phone at once; the app can also unlink its own phone. A phone is linked for the chat that owns the bot: if the bot ever comes to answer to another chat (`TELEGRAM_CHAT_ID` set or changed), phones linked for the old one are unlinked when it starts. `/status` says how many phones are linked, when any are.
- **What it cannot overdo:** the app may have Glasgow Club's sheet read afresh 12 times a minute; it may ask for a hold only on a court it was shown free in the last 15 minutes (as Telegram only offers Hold under a court on a sheet it has just shown); and one phone may keep four requests waiting for news at once. Pay and the parks have bounds of their own (above, and below).
- **What is kept:** the app proves itself with a long random token it is given once, when it pairs. The bot keeps only a fingerprint of it (its SHA-256) in the settings file, so the file opens no door, and the one-line `/backup` leaves the phones out (and, since 2.10.1, the app's signatures for your bookings: after a start from it, the app signs them again). Without a Railway volume the links are lost at each restart, and `/app` says so.
- **Notifications:** what the bot tells you unprompted in Telegram (a court booked or not, trouble before a booking, your PC not answering, how a hold ended) it also keeps as the last 30 notes for the app, and sends as a notification to each linked phone that asked for them, by Expo's push service. A notification that cannot be sent never delays or stops the Telegram message.
- **Where it comes in:** on the same web address as your PC's link, under `/app/`, so the app works wherever the PC is linked (`AGENT_PUBLIC_KEY` or `AGENT_TOKEN` is set). The two are kept apart: a phone's token opens nothing of the PC's, and the PC's key opens nothing of the app's.

The contract between the bot and the app, request by request and field by field, is [docs/app-api.md](docs/app-api.md).

### The parks, from the app (version 2.9)

In the app, Glasgow Life's seven parks on ClubSpark (Drumchapel, Garrowhill, Kelvingrove, Knightswood, Maryhill, Queens Park and Victoria Park) can be read and booked now, for any day that is already open:

- **Free courts:** your PC opens that park's booking sheet for the day in a Chrome window of its own, kept off the screen, as any visitor would, and sends back the free courts.
- **Book now:** your PC signs in to ClubSpark as its nightly run does and books exactly the court you picked, or nothing: if it has gone, it says so and takes no other. It presses "Continue booking" only after the bot says go. The outcome is an ordinary result, with the card here, a note and a notification. Bookings are free with the annual pass; your PC never pays.
- **Your home connection comes first:** a day's look is kept 3 minutes; at most 6 reads in 10 minutes, all phones together; no read from 21:00 and no booking from 21:25, until 22:30, nor while the nightly run is still going; one thing at a time, no booking beside a Glasgow Club hold (or its payment), at most 4 bookings an hour; and if ClubSpark ever turns your PC away (its "Just a moment" check, or a page that never shows, or a 403), nothing at all for 2 hours, said here in Telegram. Nothing tries to get round such a check.
- **The weekly allowance:** at most 7 sessions and 14 hours a week across the parks (taken to run Monday to Sunday). Book now, `/book`, `/set` and the app refuse what would pass it, and the nightly run is not handed a job that would, which then gets a "Not booked" card saying why. Every court the bot has booked counts, cancelled or not. Glasgow Club's courts are not part of it.
- **Scheduling** was Kelvingrove's alone until version 2.10. Since then the weekly times and one-off dates can be at any park, and at Glasgow Club (below).

### Weekly bookings at any venue (version 2.10.1)

In the app a weekly booking, or a one-off date, can be at any venue the bot knows: the seven parks, Gorbals (indoor), Scotstoun (indoor) and Scotstoun (outdoor). A weekday can have several, at different venues or times (one per venue, day and start time, and 30 weekly bookings at most), and each can be switched off and on again without losing it. Your Kelvingrove weekly times carry over as they were. Telegram's `/set`, `/off` and `/book` go on setting Kelvingrove's, and `/plan` lists them all.

- **The parks** open a day 7 days ahead at 22:00, as Kelvingrove does. Your PC's nightly run books Kelvingrove's first, exactly as before (in your court order), then each other park's in the same run: the lowest-numbered court free for the whole slot. Each gets its own card, and the weekly allowance counts them all.
- **Glasgow Club** opens a day 7 days ahead at midnight. On a night with a booking there, the nightly run stays awake past midnight. At 00:00 it puts the lowest-numbered court free at your time into your basket. With **automatic payments** on (below) it pays for it, then looks at your Bookings page. You get a card: **booked**, with the court and the price paid, or **not booked**, with why and whether anything was paid. If your bank wants you to approve the payment in its app, you are told at once, in Telegram, in the app's notes and as a notification, and the PC waits five minutes for it. With automatic payments off, no court is taken, and the card says so (as soon as the run starts, without keeping the PC awake). If no word comes by 00:25, you are told, as at 22:08. These courts are not part of the weekly allowance.
- **No court late, or after a sleep:** your PC takes a court no later than 00:30, by its own clock, and none at all if it was asleep while it waited for 00:00 (by then you may have booked by hand). It takes no court while anything is in your basket (an earlier booking's court whose payment is not known is left where it is), and a court it gives back is its own line only. A payment page that comes back saying the payment did not go through after Pay was pressed is said as "not known whether anything was paid", with the page's words: look in your banking app. A one-off at Glasgow Club is booked at its midnight; one you add after its day opened is booked at the next run (21:55), before midnight's, with a sign-in of its own. One that was on your list at its midnight is not tried again after it.
- **Scheduling at Glasgow Club as at the parks** (2.11.2): in the app, Book on a day Glasgow Club has not opened yet schedules it as a one-off date, up to 90 days ahead, signed with Face ID; your PC books and pays for it at that day's midnight. A day's look now also lists the courts free on it as it stands (`later`). Your PC learns what to book when its run starts at 21:55, so a date whose day opens at the coming midnight must be on the list by then.
- **Automatic payments** are switched on in the app. It asks for the card's security code and seals it for your PC, bound to the card your PC keeps and its pay key. The bot passes it on unopened, once, and keeps nothing of it; your PC keeps it beside the card, protected by Windows. The PC then pays only for a booking you saved in the app: since 2.10.1 the app signs each weekly booking and one-off date with the card's pay key, which only it and your PC know, and the PC checks the signature before it takes a court; a booking without one is not tried ("open it in the app and save it again"). So the bot, or whoever might take it over, cannot have your PC pay for anything else. It could still hand your PC a booking you signed and have since switched off or removed (signatures last as long as the card's pay key: forget the card, or switch automatic payments off, to stop them all), or keep one from it. The price on the slot must be the payment page's own, and at most £30 (`GLASGOW_AUTO_PAY_MAX` on the PC); the PC's daily limit still applies; every check of the payment page must pass (Pay's own); Pay is pressed once; and each booking is paid for once at most. Switching them off (always passed to your PC, even when it says it keeps no code), a new card or **Forget** deletes the code on your PC. The app shows whether they are on.
- **Your PC is left to it** around such a midnight: no Sleep from 23:00, no holds from 23:25 to 00:30, and no reads of Glasgow Club's sheets from 23:50 to 00:10. A night without a Glasgow Club booking is as before.
- **Updating:** update your PC's booker first, then the bot. Then run `schedule.ps1` on the PC once more: the nightly task may now run three hours, to see midnight out. A booker older than 2.10 is given Kelvingrove's bookings alone, and every other one gets a "Not booked" card saying to update it. A booker of 2.10.0 cannot read signatures: update it to 2.10.1 with the bot.
- **Going back to an older version:** a bot older than 2.10, started on 2.10's settings, keeps your Kelvingrove weekly times and one-off dates (and books them as before), but drops the other venues' the first time it saves. So 2.10 keeps a copy of the settings as they were before it first started, `state.pre-2.10.json`, beside `state.json` on the volume. To go back: stop the bot, copy `state.pre-2.10.json` over `state.json` (from a shell on the service, say), deploy the older version, and then set again by hand whatever you added or changed since 2.10 started (Kelvingrove's in Telegram; the rest is lost to the older version anyway). Going forward again later, add the other venues' bookings again in the app.

## The pictures

The banners in `assets/` are made from the two pictures in `art/` (the court at night, and with the floodlights on):

| Banner | Used for |
| --- | --- |
| `banner-home-awake.jpg`, `-asleep`, `-offline` | "Court Booker", with your PC's dot: the menu, the heads-up, the PC-missing warning |
| `banner-booked.jpg` | "Court booked": a booking made, with the gate code |
| `banner-missed.jpg` | "Not booked" |

To change the words or a picture, edit `art/make-banners.cjs` and run it with Chrome and the PC booker's `selenium-webdriver`:

```
NODE_PATH="<kelvingrove-court-booker folder>/node_modules" node art/make-banners.cjs
```

If Telegram ever refuses a picture, the message goes out as plain text instead.

## Variables

| Variable | Needed | What it is |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | The token from @BotFather. |
| `AGENT_PUBLIC_KEY` | Yes, to link your PC | The public key the PC prints with `node book.js --make-key`. (Or `AGENT_TOKEN`: a long random line, the same here and in the PC's `.env`.) |
| `TELEGRAM_CHAT_ID` | Recommended | Your chat ID. Locks the bot to you. |
| `COURT_SETTINGS` | If no volume | The line from `/backup`. |
| `COURT_PLAN` | No | Weekly Kelvingrove bookings to start from, for example `thu 19:00 2h, fri 19:00 2h`. |
| `COURT_ORDER` | No | A court order to start from, for example `3 4 5 2 1 6`. |
| `RELEASE_TIME` | No | When the venue releases a new day. Default `22:00`. |
| `DAYS_AHEAD` | No | How many days ahead it releases. Default `7`. |
| `DATA_DIR` | No | Where settings are kept. Default: the volume, or `/data`. |
| `WAKE_MAC` | To wake your PC | The PC's network card address, for example `44:AF:28:7A:1A:5C` (`Get-NetAdapter` on the PC). |
| `WAKE_PORT` | To wake your PC | The outside port your router forwards to the PC's port 9 (UDP). Default `9`. |
| `PORT` | No | Railway sets this. Default `8080`. |

## For developers

Plain Node 20 or later, no packages. `npm test` runs the checks.

```
index.js          start-up, the Telegram message loop and the timer
app.js            commands, what the PC is told, and the cards
lib/time.js       UK-time date maths
lib/plan.js       reading what you type: days, dates, times, court order; the weekly bookings at any venue
lib/schedule.js   which days open when (the parks at 22:00, Glasgow Club at midnight), and what the
                  PC should book now
lib/messages.js   the words
lib/server.js     the HTTP endpoint your PC talks to (GET /agent/jobs, POST /agent/ping, which may wait
                  for an instruction such as sleep, a look at Glasgow Club or a court to hold there,
                  POST /agent/look, POST /agent/hold, POST /agent/clubspark/look and /book,
                  POST /agent/progress, POST /agent/result),
                  the public banner pages for /wide, and the iPhone app's door (/app/...)
lib/appapi.js     the iPhone app's API, the parts that need nothing else: pairing codes, tokens,
                  the linked phones, the notes, and what each request must look like
lib/push.js       notifications to the linked phones, by Expo's push service
lib/ui.js         the tap-through screens and their buttons
lib/wake.js       the Wake-on-LAN magic packet, and where it may go
lib/glasgowclub.js  Glasgow Club's free courts, read as a visitor (by your PC, or from here where
                  the site allows it); never books or pays. Its table has each sheet (Gorbals,
                  Scotstoun indoor, Scotstoun outdoor) with its court type and the name it goes by
lib/venues.js     every venue the bot knows: the seven parks on ClubSpark and Glasgow Club's two
lib/clubspark.js  the parks from the app: a day's free courts and Book now, both by your PC
                  (POST /agent/clubspark/look and /book), and the limits that spare your home connection
lib/allowance.js  Glasgow Life Tennis's weekly allowance: 7 sessions and 14 hours a week
lib/telegram.js   Telegram Bot API client
lib/store.js      the settings file
assets/           the banners
art/              the pictures the banners are made from, and the script that makes them
docs/app-api.md   what the iPhone app asks of the bot, and what it is told
```

Version 1 of this bot sent court links for you to tap; version 2 books for you. Settings saved by version 1 keep your owner, weekly plan, court order and pictures.
