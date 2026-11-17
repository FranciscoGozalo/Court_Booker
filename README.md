# Court alert

A small Telegram bot for Kelvingrove Park Tennis Courts. On your booking nights it messages you a button for each court just before ClubSpark releases the new day, then turns the message to **GO** at the release.

You do the booking. You tap a court, ClubSpark shows its confirm screen, and you press Confirm and pay. The bot never contacts ClubSpark, never signs in and never books anything. It only sends messages to you.

It runs on Railway, so nothing of yours needs to be switched on.

## What a booking night looks like

Kelvingrove opens each day for booking 7 days ahead at 22:00, so the alert for a Thursday slot arrives the Thursday before.

| UK time | What arrives |
| --- | --- |
| 21:55:00 | A heads-up, with a button to check you are signed in to ClubSpark |
| 21:59:30 | Six court buttons for your slot, in your order of courts |
| 22:00:00 | The same message turns to "GO" and the buttons take colour: green for your first choice, blue for the rest |

If ClubSpark says "Sorry, your booking was unsuccessful", that court has gone. Go back and tap the next one.

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
| `/signin` | Open the booking sheet so you can sign in. |
| `/style buttons` | How the courts are shown. See below. |
| `/lead 30` | How many seconds before the release the alert arrives (5 to 300). |
| `/warn 5` | How many minutes before the release the heads-up arrives. `0` for none. |
| `/go off` | Leave the alert as it is at the release. |
| `/code` | Replace the booking code. You can also just paste a confirm-screen address. |
| `/pause`, `/resume` | Stop and restart alerts. |
| `/status` | Clock check, version, and whether settings are being kept. |
| `/backup` | Your settings as one line, for the `COURT_SETTINGS` variable. |
| `/id` | Your chat ID. |

## How the courts are shown

Telegram asks "Open this link?" before it opens a button's link. An address written out in the message opens on the first tap, but ClubSpark's addresses are long. So there are three styles:

- `/style buttons` (the default): court buttons only. Tidy; each court is a tap and a confirm.
- `/style both`: the buttons, plus your first-choice court written out as a link that opens in one tap.
- `/style links`: all six courts written out. One tap each, but a long message.

Send `/test` after changing it to see how it looks.

## Good to know

- **Sign in where the links open.** Telegram opens links in its own browser unless you have told it to use Safari, and that browser has its own ClubSpark sign-in. Use `/signin`, or the button on the heads-up, so you are signed in before the links arrive.
- **The bot cannot see which courts are free.** It does not look at ClubSpark at all. It offers all six courts in your order.
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

Saved settings win over `COURT_SETTINGS`, which wins over `COURT_PLAN` and `COURT_ORDER`.

## For developers

Plain Node 20 or later, no packages. `npm test` runs the checks, including whole release nights replayed on a stepped clock.

```
index.js          start-up, the Telegram message loop and the timer
app.js            commands and the timed messages
lib/time.js       UK-time date maths
lib/links.js      the ClubSpark addresses
lib/plan.js       reading what you type
lib/schedule.js   which messages are due when
lib/messages.js   the words and buttons
lib/telegram.js   Telegram Bot API client
lib/store.js      the settings file
```
