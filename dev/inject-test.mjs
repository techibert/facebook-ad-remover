// Injects the current content.js + content.css into the live Facebook tab of a browser
// started with --remote-debugging-port=9222, scrolls, and reports what got marked.
//
//   npm i puppeteer-core   (once, in this dev/ folder)
//   node dev/inject-test.mjs [url] [steps]
//
// Use a fresh page load (the default) so an installed copy of the extension and
// this injected copy don't both run the old code on the page.

import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'https://www.facebook.com/';
const steps = Number(process.argv[3] || 30);

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const page = (await browser.pages()).find((p) => p.url().includes('facebook.com')) || (await browser.newPage());
await page.bringToFront();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 4000));

await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'content.css'), 'utf8') });
const stub = `var chrome = {
  storage: { sync: { get: (d, cb) => cb(d) }, onChanged: { addListener() {} } },
  runtime: { onMessage: { addListener(f) { window.__farCount = () => { let r; f({ type: 'far:count' }, null, (x) => (r = x)); return r; }; } } },
};`;
await page.evaluate(stub + fs.readFileSync(path.join(root, 'content.js'), 'utf8'));

const seen = new Set();
for (let i = 0; i < steps; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-far-ad]')].map((e) => ({
      kind: e.getAttribute('data-far-ad'),
      name: (e.querySelector('[data-ad-rendering-role="profile_name"]')?.innerText || e.innerText)
        .split('\n').filter(Boolean)[0]?.slice(0, 50) || '(empty)',
    })),
  );
  for (const r of rows) {
    const key = r.kind + r.name;
    if (!seen.has(key)) {
      seen.add(key);
      console.log('MARKED', r.kind.padEnd(12), r.name);
    }
  }
  await page.evaluate(() => scrollBy(0, 600));
}

console.log('count', await page.evaluate(() => window.__farCount()));
await page.screenshot({ path: path.join(root, 'dev', 'last-run.png') });
browser.disconnect();
