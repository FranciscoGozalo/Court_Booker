# Court alert

A small Telegram bot for Kelvingrove Park Tennis Courts. On your booking nights it messages you a card just before ClubSpark releases the new day, then turns the card to **GO** at the release. It reads the public booking sheet to see which courts are free, so the card leads with one button: the first free court in your order. If that court is taken, the card moves on to the next free one.

You do the booking. You tap the court, ClubSpark shows its confirm screen, and you press Confirm and pay. The bot never signs in and never books anything. The only thing it asks ClubSpark for is the booking sheet that anyone can see without signing in.

It runs on Railway, so nothing of yours needs to be switched on.

## What a booking night looks like

Kelvingrove opens each day for booking 7 days ahead at 22:00, so the alert for a Thursday slot arrives the Thursday before.

| UK time | What arrives |
| --- | --- |
| 21:55:00 | A heads-up, with a button to check you are signed in to ClubSpark |
| 21:59:30 | A card: a picture of the court with the floodlights off, your slot, and a wide **Book Court 4** button for the first free court in your order, with the other free courts under it |
| 22:00:00 | The same card turns to "GO · tap Court 4 now": the words at once, then the picture, with the floodlights on |
| 22:00 to 22:05 | The bot keeps reading the sheet. When Court 4 is taken, the card changes to "tap Court 3 now", and so on |

If ClubSpark says "Sorry, your booking was unsuccessful", that court has gone. Go back to the card: within a few seconds it shows the next free court.

## Which courts are free

The bot reads the same booking sheet you see on ClubSpark without signing in. It starts 15 seconds before the card goes out and stops five minutes after the release. It reads every 2 seconds for the first half-minute after the release, then less often: about 50 reads a night, only on your booking nights.

- **The card leads with the first free court in your order.** The other free courts are under it, then the whole sheet. Courts that are booked, taken by coaching or closed are left off.
- **Nothing moves in the last three seconds before GO.** If the sheet changes then, the change arrives with GO itself.
- **If no court shows as free** after the release, the card says so and offers all six anyway, in case the sheet is behind. A court that comes back, for example because someone did not finish paying, is offered again.
- **If the sheet cannot be read**, the card is exactly what it was before this feature: all six courts in your order, with a line saying the check did not work. One failed read is not mentioned. Three in a row are, and if ClubSpark turns the server away the bot stops asking for the night.

**Does it work from Railway?** Often not. ClubSpark is behind Cloudflare, which turns away cloud servers like Railway (it answers them `HTTP 403`). After each deploy the bot's start-up message says `Free-court check: working` or `not working`, with the reason, and `/free` tries it any time. If it does not work, nothing else changes: you get the six buttons as before, and `/free off` stops it trying. To get the free-court check working when Railway is blocked, read the next section.

## Run the check from your home server (when Railway is blocked)

Cloudflare turns away Railway, but it lets your home connection in, the same way it lets your phone in. So the booking sheet is read from a small program on a machine at home, which sends what it finds to the Railway bot. The Railway bot still does everything else and still sends every alert, so if the home machine is off you simply fall back to the six-button card.

Nothing here disguises anything: the home program reads the public booking sheet the ordinary way and says honestly what it is. It never signs in and never books.

**What you need:** a machine at home that is on at 22:00 on your booking nights (a Raspberry Pi, a NAS, an always-on PC) with Node 20 or later.

1. **Give the Railway bot a web address.** In Railway, open the service, go to **Settings > Networking**, and choose **Generate Domain**. You get an address like `https://court-booker-production.up.railway.app`. (The bot only opens this web address once the next step is done.)
2. **Make a shared password.** Invent one long random line — this is `AGENT_TOKEN`, and it is the only thing guarding the web address. In Railway, under **Variables**, add `AGENT_TOKEN` with that line. Railway redeploys; the log now says `Listening for the home server` and `Free-court readings will come from a home server`.
3. **Run the home program.** On the home machine, get this repository (`git clone`, or copy the folder) and run:

   ```
   RELAY_URL=https://your-railway-address  AGENT_TOKEN=the-same-line  node home-agent.js
   ```

   It should print `Reached the Railway bot and the token works.` Leave it running. On a booking night it reads the sheet around the release and sends the results to the bot; the rest of the time it sits quietly.
4. **Keep it running.** So it starts on its own after a reboot or power cut, run it under whatever your machine uses — a `systemd` service on Linux, `pm2`, or Task Scheduler on Windows. It needs only `RELAY_URL` and `AGENT_TOKEN`.

Check it is working: send `/status` to the bot. It says `last reading from your home server at …` once a reading has arrived (that happens around the release, so on a quiet afternoon it will say it is waiting). If the home machine goes quiet mid-release, the card falls back to all six courts within half a minute and the alert still reaches you.

The home program and the Railway bot must use the **same** `AGENT_TOKEN`. Do not put your Telegram token on the home machine; it does not need it.

## Set it up from a phone

### 1. Make the bot in Telegram

1. In Telegram, open a chat with **@BotFather** and send `/newbot`.
2. Give it a name (for example "Court alert") and a username ending in `bot`.
3. BotFather replies with a token: a long line that looks like `1234567890:AAH...`. Copy it. Treat it like a password.

### 2. Put it on Railway

1. In Railway: **New Project**, then **Deploy from GitHub repo**, then pick **Court_Booker**. If the repo is not listed, choose **Configure GitHub App** and allow Railway to see it.
2. Open the new service, go to **Variables**, and add `TELEGRAM_BOT_TOKEN` with the token from BotFather.
3. Railway builds and starts it. In **Deployments > View logs** you should see `Signed in to Telegram as @yourbot`.

### 3. Claim it

Open your bot in Telegram and press **Start**. The first person to send `/start` becomes its owner, and it ignores everyone else.

It replies with your chat ID. Add that in Railway as the variable `TELEGRAM_CHAT_ID` so the bot is locked to you for good.

### 4. Tell it your plan

```
/set thu 19:00 2h
/set fri 19:00 2h
/order 4 3 5 2 6 1
```

Then send `/signin`, sign in to ClubSpark on the page that opens, and send `/test`. The test sends real links for a day that is already open, so every court that is free should show the confirm screen. Back out without confirming and nothing is booked.

### 5. Make it remember

Out of the box, Railway forgets the bot's settings each time it restarts. Do one of these:

- **A volume (best).** In the Railway project, create a **Volume**, attach it to this service and set the mount path to `/data`. Everything you set in the chat is then kept.
- **A variable.** Send `/backup`. The bot replies with one line. Save it in Railway as the variable `COURT_SETTINGS`. Send `/backup` again whenever you change your plan.

`/status` tells you whether settings are being kept.

## Commands

| Command | What it does |
| --- | --- |
| `/set thu 19:00 2h` | Alert for Thursdays at 19:00 for two hours. `1h` or `2h`. Also understands `7pm` and `19:00-21:00`. |
| `/off thu` | Stop Thursdays. `/off all` clears everything. |
| `/order 4 3 5 2 6 1` | Which courts to offer first. |
| `/plan` | Your plan and when the next alert is due. |
| `/test` | Send the courts now, for a day that is already open. |
| `/free` | Which courts are free now, for your next slot on a day that is open. `/free off` shows all six courts on the night without reading the sheet; `/free on` brings the check back. |
| `/signin` | Open the booking sheet so you can sign in. |
| `/style card` | How the courts are shown. See below. |
| `/lead 30` | How many seconds before the release the alert arrives (5 to 300). |
| `/warn 5` | How many minutes before the release the heads-up arrives. `0` for none. |
| `/go off` | Leave the alert as it is at the release. |
| `/code` | Replace the booking code. You can also just paste a confirm-screen address. |
| `/pause`, `/resume` | Stop and restart alerts. |
| `/status` | Clock check, version, and whether settings are being kept. |
| `/backup` | Your settings as one line, for the `COURT_SETTINGS` variable. |
| `/id` | Your chat ID. |

## How the courts are shown

- `/style card` (the default): a picture on top, your slot and the status under it, then the court buttons. At the release the words turn to GO and the picture changes.
- `/style buttons`: the same words and buttons as plain text, with no picture.
- `/style both`: plain text, plus the court the card leads with written out as a link.
- `/style links`: the courts written out as links (the free ones, once the sheet has been read). No buttons, and a long message.

Telegram asks "Open this link?" before it opens a button's link. An address written out in the message opens on the first tap, which is what `both` and `links` are for, but ClubSpark's addresses are long.

If Telegram ever refuses a picture, the alert goes out as plain text instead, so a picture can never cost you an alert.

## The pictures

The two banners the bot sends are `assets/banner-wait.jpg` and `assets/banner-open.jpg`, 1280 by 480 pixels. They are made from the two pictures in `art/` (`wait.jpg` and `open.jpg`) by laying the words over them:

```
NODE_PATH=$(npm root -g) node art/make-banners.cjs
```

To change a picture, replace the file in `art/` with another of the same shape, keep its left third dark and plain for the words, and run that again. The bot notices a changed banner by itself and uploads it the next time it is needed.

## Good to know

- **Sign in where the links open.** Telegram opens links in its own browser unless you have told it to use Safari, and that browser has its own ClubSpark sign-in. Use `/signin`, or the button on the heads-up, so you are signed in before the links arrive.
- **What the bot sends ClubSpark.** One plain request for the booking sheet's data for your day (`/v0/VenueBooking/KelvingroveParkTennisCourts/GetVenueSessions`), with no cookies, no sign-in and nothing about you. It says who it is in its user agent.
- **A court leaving the card does not mean someone else got it.** When you book Court 4 yourself, the next read shows it booked and the card moves on to Court 3. That is expected.
- **The booking code.** Each link carries a code from Kelvingrove's schedule. The one built in was taken from a real confirm screen on 16 November 2026 and opened every court, day and price band tried. If the links ever stop opening the confirm screen, tap a free slot on the sheet, press Continue booking, copy the address of the screen that follows and paste it to the bot.
- **Timing.** The bot works on UK time and follows the clock changes. `/status` compares the server's clock with Telegram's.
- **Restarts.** With a volume, each message is sent once per night even if the bot restarts, and a restart between the links and GO still turns the same message to GO. Without a volume, a restart in the last minute can send the links twice.

## Variables

| Variable | Needed | What it is |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | The token from @BotFather. |
| `TELEGRAM_CHAT_ID` | Recommended | Your chat ID. Locks the bot to you. |
| `COURT_SETTINGS` | If no volume | The line from `/backup`. Used when there are no saved settings. |
| `COURT_PLAN` | No | A plan to start from, for example `thu 19:00 2h, fri 19:00 2h`. |
| `COURT_ORDER` | No | A court order to start from, for example `4 3 5 2 6 1`. |
| `RELEASE_TIME` | No | When the venue releases a new day. Default `22:00`. |
| `DAYS_AHEAD` | No | How many days ahead it releases. Default `7`. |
| `DATA_DIR` | No | Where settings are kept. Default: the volume, or `/data`. |
| `AGENT_TOKEN` | For a home server | A long random line, the same on the Railway bot and the home program. Set it on the Railway bot to make it take readings from a home server instead of reading ClubSpark itself. |
| `PORT` | No | The port the home-server endpoint listens on. Railway sets this for you. Default `8080`. |

On the **home machine**, `home-agent.js` needs two of its own: `RELAY_URL` (the Railway bot's web address) and the same `AGENT_TOKEN`. Nothing else, and not the Telegram token.

Saved settings win over `COURT_SETTINGS`, which wins over `COURT_PLAN` and `COURT_ORDER`.

## For developers

Plain Node 20 or later, no packages. `npm test` runs the checks, including whole release nights replayed on a stepped clock.

```
index.js          start-up, the Telegram message loop and the timer
home-agent.js     the home-server program: reads the sheet, posts to Railway
app.js            commands and the timed messages
lib/time.js       UK-time date maths
lib/links.js      the ClubSpark addresses
lib/availability.js  reading the booking sheet: which courts are free
lib/relay.js      Railway's buffer for readings a home server posts
lib/server.js     the HTTP endpoint the home server talks to
lib/agent.js      the home server's read-scheduling
lib/plan.js       reading what you type
lib/schedule.js   which messages are due when
lib/messages.js   the words and buttons
lib/telegram.js   Telegram Bot API client
lib/store.js      the settings file
assets/           the two banners the bot sends
art/              the pictures the banners are made from, and the script that makes them
```
