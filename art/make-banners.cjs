'use strict';
// Makes the two banners the bot sends (assets/banner-wait.jpg and assets/banner-open.jpg)
// from the two pictures in this folder (wait.jpg and open.jpg) by laying the words over them.
//
// Run it again after replacing a picture or changing the words below:
//   NODE_PATH=$(npm root -g) node art/make-banners.cjs
// It needs Playwright with Chrome, and the Inter typeface installed. The bot itself needs neither.
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const W = 1280, H = 480;
const BANNERS = [
  { name: 'wait', title: ['Court', 'release'], colour: '#FFFFFF' },
  { name: 'open', title: ['Booking', 'open'], colour: '#E4FB5A' },
];

const page = (b, picture) => `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: #000; }
#b { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: url("${picture}") center / cover no-repeat; font-family: 'Inter Display', 'Inter', sans-serif; }
#b::before { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(3, 8, 14, .78) 0%, rgba(3, 8, 14, .62) 30%, rgba(3, 8, 14, 0) 52%); }
.t { position: absolute; left: 76px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; }
.e { display: flex; align-items: center; gap: 18px; font-family: 'Inter', sans-serif; font-weight: 600; font-size: 32px; letter-spacing: .14em; text-transform: uppercase; color: rgba(255, 255, 255, .86); }
.d { width: 22px; height: 22px; border-radius: 50%; background: #E4FB5A; }
.h { margin-top: 20px; font-weight: 650; font-size: 112px; line-height: .98; letter-spacing: -.028em; color: ${b.colour}; text-shadow: 0 2px 24px rgba(0, 0, 0, .35); }
</style></head><body><div id="b"><div class="t">
<div class="e"><span class="d"></span>Kelvingrove Park</div>
<div class="h">${b.title.join('<br>')}</div>
</div></div></body></html>`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--allow-file-access-from-files'] });
  const tab = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  for (const b of BANNERS) {
    const picture = pathToFileURL(path.join(__dirname, `${b.name}.jpg`)).href;
    await tab.goto(pathToFileURL(path.join(__dirname, 'make-banners.cjs')).href);   // a file: page, so the picture may load
    await tab.setContent(page(b, picture), { waitUntil: 'load' });
    await tab.evaluate(() => document.fonts.ready);
    const box = await tab.evaluate(() => { const r = document.querySelector('.e').getBoundingClientRect(); const t = document.querySelector('.h').getBoundingClientRect(); return [Math.round(r.right), Math.round(t.right)]; });
    const out = path.join(__dirname, '..', 'assets', `banner-${b.name}.jpg`);
    await tab.locator('#b').screenshot({ path: out, type: 'jpeg', quality: 90 });
    console.log(`${out}  (the words end at x=${box[0]} and x=${box[1]}; keep them clear of anything bright in the picture)`);
  }
  await browser.close();
})();
