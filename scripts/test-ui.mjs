// Browser smoke test of the production build, Content Security Policy included.
// Run with: npm run test:ui   (needs the local Supabase stack running)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5173/relationship-crm/';
const MAIL = 'http://127.0.0.1:54324';
const SHOTS = new URL('../test-results/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, name, detail = '') => {
  console.log(`${ok ? 'ok    ' : 'FAIL  '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
};

const server = spawn('npx', ['vite', 'preview', '--port', '5173', '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 40; i++) {
  if (await fetch(BASE).then(r => r.ok, () => false)) break;
  await new Promise(r => setTimeout(r, 250));
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('dialog', d => { problems.push(`dialog opened: ${d.message()}`); d.dismiss(); });
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation',
    e => console.error(`CSP blocked ${e.blockedURI} (${e.violatedDirective})`)));

  // Sign in with a magic link from the local inbox.
  const email = `ui-${Date.now()}@example.com`;
  await page.goto(BASE);
  await page.fill('#email', email);
  await page.click('text=Email me a sign-in link');
  await page.waitForSelector('text=Check your email');
  check(true, 'sign-in form sends a link');
  let link;
  for (let i = 0; i < 20 && !link; i++) {
    const list = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`).then(r => r.json());
    if (list.messages?.[0]) {
      const msg = await fetch(`${MAIL}/api/v1/message/${list.messages[0].ID}`).then(r => r.json());
      link = (msg.Text || '').match(/https?:\/\/\S+\/auth\/v1\/verify\?[^\s)]+/)?.[0];
    }
    if (!link) await new Promise(r => setTimeout(r, 500));
  }
  await page.goto(link);
  await page.waitForSelector('text=Your projects', { timeout: 10000 });
  check(true, 'magic link signs in and opens the project list');
  check(!page.url().includes('code='), 'the sign-in code is removed from the address bar', page.url());
  await page.screenshot({ path: `${SHOTS}1-projects-empty.png` });

  // Create a project and add elements.
  await page.fill('#new-project', 'Neighborhood partners');
  await page.click('text=Create project');
  await page.waitForSelector('#new-element-label');
  for (const [label, type] of [['Ada Lovelace', 'person'], ['Grace Hopper', 'person'], ['Acme Foundation', 'organization'], ['Library', 'place']]) {
    await page.fill('#new-element-label', label);
    await page.fill('#new-element-type', type);
    await page.press('#new-element-label', 'Enter');
    await page.waitForSelector(`.element-list >> text=${label}`);
  }
  check(await page.locator('.element-list li').count() === 4, 'four elements added');
  check(await page.evaluate(() => document.activeElement?.id) === 'new-element-label', 'focus returns to the name field for quick entry');

  // An element name that would run script if it were ever treated as HTML.
  const xss = '<img src=x onerror="alert(1)">';
  await page.fill('#new-element-label', xss);
  await page.press('#new-element-label', 'Enter');
  await page.waitForSelector('.element-list >> text=<img');
  check(await page.locator('.element-list img').count() === 0, 'an element name containing HTML is shown as text');

  // Open an element and connect it.
  await page.click('.element-list >> text=Ada Lovelace');
  await page.waitForSelector('#conn-target');
  await page.fill('#conn-target', 'Grace Hopper');
  await page.fill('#conn-type', 'mentor');
  await page.click('text=Add connection');
  await page.waitForSelector('.connection-list >> text=Grace Hopper');
  await page.fill('#conn-target', 'Acme Foundation');
  await page.fill('#conn-type', 'funded by');
  await page.selectOption('#conn-dir', 'in');
  await page.click('text=Add connection');
  await page.waitForSelector('.connection-list >> text=Acme Foundation');
  await page.fill('#conn-target', 'City Council');
  check(await page.isVisible('text=isn\'t in this project yet'), 'typing a new name explains it will be created');
  await page.fill('#conn-type', 'advises');
  await page.selectOption('#conn-dir', 'mutual');
  await page.click('text=Add connection');
  await page.waitForSelector('.connection-list >> text=City Council');
  check(await page.locator('.connection-list li').count() === 3, 'three connections listed');
  check(await page.locator('.egomap .node').count() === 3, 'the map shows three connected elements');
  check(await page.locator('.element-list li').count() === 6, 'the new name became an element');
  await page.screenshot({ path: `${SHOTS}2-element-light.png`, fullPage: true });

  // Clicking a node on the map opens that element.
  await page.click('.egomap .node >> text=Grace Hopper');
  await page.waitForSelector('#el-label[value="Grace Hopper"]');
  check(await page.isVisible('.connection-list >> text=Ada Lovelace'), 'the map links to the connected element, which shows the connection back');

  // Edit and save.
  await page.fill('#el-desc', 'Pioneer of compilers.');
  await page.click('text=Save changes');
  await page.waitForSelector('text=Saved');
  await page.reload();
  await page.waitForSelector('#el-desc');
  check(await page.inputValue('#el-desc') === 'Pioneer of compilers.', 'notes are saved');

  // Project list, dark mode and phone width.
  await page.goto(BASE);
  await page.waitForSelector('.note');
  await page.screenshot({ path: `${SHOTS}3-projects.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('.note');
  await page.click('.element-list >> text=Ada Lovelace');
  await page.waitForSelector('.egomap');
  await page.screenshot({ path: `${SHOTS}4-element-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: `${SHOTS}5-element-phone.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, 'nothing scrolls sideways at phone width', `${overflow}px too wide`);

  // Fonts came from the site itself, not a third party.
  check(await page.evaluate(() => document.fonts.check('700 20px Kalam')), 'the handwritten font loaded');

  // Sign out returns to the sign-in screen and hides the data.
  await page.click('text=Sign out');
  await page.waitForSelector('#email');
  check(true, 'sign out returns to the sign-in screen');

  check(problems.length === 0, 'no console errors, security-policy violations or dialogs', problems.join(' | '));
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : `\nAll UI checks passed. Screenshots: ${SHOTS}`);
process.exit(failures ? 1 : 0);
