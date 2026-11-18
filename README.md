# Court booker

A small Telegram bot for Kelvingrove Park Tennis Courts. You tell it what you want to play, every week or on single dates, and it gets them booked. When each day opens for booking, your PC at home signs in to ClubSpark and books the first free court in your order. The bot then sends you a card with the court, the time and the **gate code**.

The work is split in two because ClubSpark sits behind Cloudflare, which turns cloud servers like Railway away:

- **The bot runs on Railway.** It is always online, keeps your requests, answers your messages and sends the cards.
- **The booker runs on your PC.** It is in the separate repository [kelvingrove-court-booker](https://github.com/FranciscoGozalo/kelvingrove-court-booker). A Windows task wakes the PC at 21:55, the booker asks this bot what to book, books it at 22:00 and reports back.

Your ClubSpark password stays on your PC. The bot never sees it and never touches ClubSpark.

## What a booking night looks like

Kelvingrove opens each day 7 days ahead at 22:00. So a Thursday is booked on the Thursday before.

| UK time | What happens |
| --- | --- |
| 21:55 | Your PC wakes, signs in and checks in with the bot. You get a card with the green "PC awake" dot: what it is about to book. |
| 21:58 | Only if your PC has **not** checked in: a warning, so you can book by hand. |
| 22:00 | The PC books the first free court in your order for the whole slot. |
| 22:00:10 or so | A card on the "Court booked" banner: **Booked · Court 3**, the date and time, and the gate code. If nothing was free, a card on the "Not booked" banner saying why. |

A one-off date that is already open is booked on the PC's next run (21:55 that night), or straight away if you start the booker on the PC by hand.

## Commands

| Command | What it does |
| --- | --- |
| `/menu` | Buttons for everything below: book a date from a calendar, set weekly days, see and remove bookings, court order, pause, status. Each tap changes the same card. |
| `/set thu 19:00 2h` | Book Thursdays at 19:00 for two hours, every week. `1h` or `2h`. Also understands `7pm` and `19:00-21:00`. |
| `/off thu` | Stop Thursdays. `/off all` clears every weekly booking. |
| `/book 25 nov 19:00 2h` | Book one date. Also `25/11`, `wed` (the coming Wednesday), `tomorrow`, `2026-11-25`. |
| `/cancel 2` | Remove one-off number 2 from `/plan`. `/cancel 25 nov` removes that date's. |
| `/plan` | Your weekly and one-off bookings, how each stands, and the next booking run. |
| `/order 3 4 5 2 1 6` | Which courts to try first. |
| `/pause`, `/resume` | Stop and restart booking. |
| `/status` | Clock check, version, your PC's state and when it was last in touch, and whether settings are kept. |
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
lib/server.js     the HTTP endpoint your PC talks to (GET /agent/jobs, POST /agent/ping, POST /agent/result),
                  and the public banner pages for /wide
lib/ui.js         the tap-through screens and their buttons
lib/telegram.js   Telegram Bot API client
lib/store.js      the settings file
assets/           the banners
art/              the pictures the banners are made from, and the script that makes them
```

Version 1 of this bot sent court links for you to tap; version 2 books for you. Settings saved by version 1 keep your owner, weekly plan, court order and pictures.
