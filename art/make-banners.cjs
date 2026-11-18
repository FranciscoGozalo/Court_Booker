'use strict';
// Makes the banners the bot sends (assets/banner-*.jpg) from the two pictures in this folder
// (wait.jpg: the court at night; open.jpg: floodlights on) by laying the words over them.
//
//   home-awake / home-asleep / home-offline   the menu card, with your PC's state as a coloured dot
//   booked                                     a court was booked
//   missed                                     no court was booked
//
// Run it again after replacing a picture or changing the words below. It drives Chrome through
// selenium-webdriver (borrowed from the PC booker's folder) and takes Inter from Google Fonts:
//   NODE_PATH="<ClubSpark Court Booker>/node_modules" node art/make-banners.cjs
// The bot itself needs neither.
const fs = require('fs');
const path = require('path');
const { Builder } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const W = 1280, H = 480;
const LIME = '#E4FB5A';
const BANNERS = [
  { name: 'home-awake', picture: 'wait', title: ['Court', 'Booker'], status: ['PC awake', '#4ADE80'] },
  { name: 'home-asleep', picture: 'wait', title: ['Court', 'Booker'], status: ['PC asleep', '#FBBF24'] },
  { name: 'home-offline', picture: 'wait', title: ['Court', 'Booker'], status: ['PC offline', '#F87171'] },
  { name: 'booked', picture: 'open', title: ['Court', 'booked'], colour: LIME },
  { name: 'missed', picture: 'wait', title: ['Not', 'booked'] },
];

const page = (b, picture) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,500..700&display=block">
<style>
html, body { margin: 0; background: #000; overflow: hidden; }
#b { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: url("${picture}") center / cover no-repeat; font-family: 'Inter', sans-serif; font-optical-sizing: auto; }
#b::before { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(3, 8, 14, .80) 0%, rgba(3, 8, 14, .64) 32%, rgba(3, 8, 14, 0) 56%); }
.t { position: absolute; left: 76px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; }
.e { font-weight: 600; font-size: 30px; letter-spacing: .16em; text-transform: uppercase; color: rgba(255, 255, 255, .80); }
.h { margin-top: 16px; font-weight: 680; font-size: 112px; line-height: .98; letter-spacing: -.03em; color: ${b.colour || '#FFFFFF'}; text-shadow: 0 2px 24px rgba(0, 0, 0, .35); }
.s { align-self: flex-start; margin-top: 30px; display: flex; align-items: center; gap: 16px; padding: 11px 26px 11px 20px; border-radius: 999px;
     background: rgba(6, 12, 20, .62); border: 2px solid rgba(255, 255, 255, .16); font-weight: 600; font-size: 30px; color: rgba(255, 255, 255, .94); }
.d { width: 20px; height: 20px; border-radius: 50%; }
</style></head><body><div id="b"><div class="t">
<div class="e">Kelvingrove Park</div>
<div class="h">${b.title.join('<br>')}</div>
${b.status ? `<div class="s"><span class="d" style="background:${b.status[1]};box-shadow:0 0 14px ${b.status[1]}"></span>${b.status[0]}</div>` : ''}
</div></div></body></html>`;

(async () => {
  const options = new chrome.Options().addArguments('--headless=new', `--window-size=${W},${H}`, '--force-device-scale-factor=1', '--hide-scrollbars', '--allow-file-access-from-files');
  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  const tmp = path.join(__dirname, '.render.html');
  try {
    // The window's inner size is not exact in headless Chrome, so set the page size outright.
    await driver.sendDevToolsCommand('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    for (const b of BANNERS) {
      fs.writeFileSync(tmp, page(b, `${b.picture}.jpg`));              // beside the pictures, so they load
      await driver.get(require('url').pathToFileURL(tmp).href);
      await driver.executeAsyncScript('const done = arguments[arguments.length - 1]; document.fonts.ready.then(() => done(document.fonts.check("680 112px Inter")))');
      const box = await driver.executeScript('const r = s => Math.round(document.querySelector(s).getBoundingClientRect().right); return [r(".e"), r(".h")]');
      const shot = await driver.sendAndGetDevToolsCommand('Page.captureScreenshot', { format: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
      const out = path.join(__dirname, '..', 'assets', `banner-${b.name}.jpg`);
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log(`${path.basename(out)}  (words end at x=${box.join(' and x=')}; keep them clear of anything bright in the picture)`);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
    await driver.quit();
  }
})();
