# Court booker

A small Telegram bot for Kelvingrove Park Tennis Courts. You tell it what you want to play, every week or on single dates, and it gets them booked. When each day opens for booking, your PC at home signs in to ClubSpark and books the first free court in your order. The bot then sends you a card with the court, the time and the **gate code**.

The work is split in two because ClubSpark sits behind Cloudflare, which turns cloud servers like Railway away:

- **The bot runs on Railway.** It is always online, keeps your requests, answers your messages and sends the cards.
- **The booker runs on your PC.** It is in the separate repository [kelvingrove-court-booker](https://github.com/FranciscoGozalo/kelvingrove-court-booker). A Windows task wakes the PC at 21:55, the booker asks this bot what to book, books it at 22:00 and reports back.

Your ClubSpark password stays on your PC. The bot never sees it and never touches ClubSpark.

It also finds free **indoor courts at Gorbals and Scotstoun** (Glasgow Club) and hands you the page to book and pay on; see [Indoor courts](#indoor-courts-glasgow-club).

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

## Indoor courts (Glasgow Club)

**Book a date** on the menu first asks where: Kelvingrove Park, Gorbals or Scotstoun. For the two indoor centres the bot shows a day's free start times, read from Glasgow Club's booking site as any visitor sees them, then which courts are free at the time you pick, and a button that opens that day's sheet on Glasgow Club's own page. You book and pay there.

The bot goes no further than that, and here is why. Glasgow Club takes a card payment with each booking. Its site keeps the basket in the browser tab that filled it, so a court put in a basket on one device cannot be paid for on another. And its own settings have saved cards and pay-by-link switched off (`GladstonePay_AllowMemberWallet` and `PayByLink_Enabled`, as read on 19 Nov 2026). So there is nothing a bot or a PC could hold for you to pay for later from your phone: the booking and the payment happen together, in your own browser.

Each day opens for booking a week ahead, at midnight. A day that has not opened yet is shown with the time it opens and what is free as it stands.

Glasgow Club's site turns cloud servers away with a "checking your browser" page, as ClubSpark does, so the bot on Railway cannot read the free courts itself. **Your PC reads them** while it is awake: the bot asks on the PC link's ping, the PC makes the two requests any visitor's browser makes (a visitor's session, then the day's sheet; never your login) and passes the sheet on. A day is read at most once a minute, and an answer usually takes a second or two.

If your PC is asleep, the card says so and offers **Wake my PC** (when waking is set up); the link to the sheet is there either way. From ten minutes before a Kelvingrove booking to ten minutes after, nothing is asked of the PC. If the site ever checks visitors from your home connection too, the PC says so and is not asked again for an hour. Nothing, on the bot or the PC, tries to get round such a check. `/status` says when the free courts were last read, and by which way.

## Commands

| Command | What it does |
| --- | --- |
| `/menu` | Buttons for everything below: book a date from a calendar, set weekly days, see and remove bookings, court order, pause, status. Each tap changes the same card. |
| `/set thu 19:00 2h` | Book Thursdays at 19:00 for two hours, every week. `1h` or `2h`. Also understands `7pm` and `19:00-21:00`. |
| `/off thu` | Stop Thursdays. `/off all` clears every weekly booking. |
| `/book 25 nov 19:00 2h` | Book one Kelvingrove date. `/book` alone asks where first. Also `25/11`, `wed` (the coming Wednesday), `tomorrow`, `2026-11-25`. |
| `/cancel 2` | Remove one-off number 2 from `/plan`. `/cancel 25 nov` removes that date's. |
| `/gorbals`, `/scotstoun` | The free indoor courts at that centre: pick a day, then a start time, then open Glasgow Club's page to book and pay. See [Indoor courts](#indoor-courts-glasgow-club). |
| `/plan` | Your weekly and one-off bookings, how each stands, and the next booking run. |
| `/order 3 4 5 2 1 6` | Which courts to try first. |
| `/pause`, `/resume` | Stop and restart booking. |
| `/status` | Clock check, version, your PC's state and when it was last in touch, whether waking is ready, and whether settings are kept. |
| `/wake` | Wake your PC from sleep (the same as **Wake my PC** on the menu). See [Waking your PC](#waking-your-pc). |
| `/sleep` | Put your PC to sleep (the same as **Sleep my PC** on the menu, without the "are you sure?"). See [Sleeping your PC](#sleeping-your-pc). |
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
| `COURT_PLAN` | No | Weekly bookings to start from, for example `thu 19:00 2h, fri 19:00 2h`. |
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
lib/plan.js       reading what you type: days, dates, times, court order
lib/schedule.js   which days open when, and what the PC should book now
lib/messages.js   the words
lib/server.js     the HTTP endpoint your PC talks to (GET /agent/jobs, POST /agent/ping, which may wait
                  for an instruction such as sleep or a look at Glasgow Club, POST /agent/look,
                  POST /agent/progress, POST /agent/result),
                  and the public banner pages for /wide
lib/ui.js         the tap-through screens and their buttons
lib/wake.js       the Wake-on-LAN magic packet, and where it may go
lib/glasgowclub.js  Glasgow Club's free indoor courts, read as a visitor (by your PC, or from here
                  where the site allows it); never books or pays
lib/telegram.js   Telegram Bot API client
lib/store.js      the settings file
assets/           the banners
art/              the pictures the banners are made from, and the script that makes them
```

Version 1 of this bot sent court links for you to tap; version 2 books for you. Settings saved by version 1 keep your owner, weekly plan, court order and pictures.
