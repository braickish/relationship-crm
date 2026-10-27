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

  const item = label => page.locator('li.el').filter({ has: page.locator(`:scope > a.name:text-is("${label}"), :scope > input.name`) }).first();
  const conns = label => page.locator('li.el', { has: page.locator(`:scope > a.name:text-is("${label}")`) }).locator('.conn');
  const openItem = () => page.locator('li.el.open');

  // Sign in with a magic link from the local inbox.
  const email = `ui-${Date.now()}@example.com`;
  await page.goto(BASE);
  await page.fill('#email', email);
  await page.click('text=send me a link');
  await page.waitForSelector('text=Check your email');
  await page.screenshot({ path: `${SHOTS}0-signin-sent.png` });
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
  await page.waitForSelector('h1:text("Projects")', { timeout: 10000 });
  check(true, 'magic link signs in and opens the project list');
  check(!page.url().includes('code='), 'the sign-in code is removed from the address bar', page.url());

  // A project is one line.
  await page.fill('#new-project', 'Neighborhood partners');
  await page.press('#new-project', 'Enter');
  await page.waitForSelector('#add-line');
  check(await page.evaluate(() => document.activeElement?.id) === 'add-line', 'a new project opens with the cursor on its first line');

  // Names and connections are lines too.
  for (const line of ['Ada Lovelace', 'Grace Hopper', 'Acme Foundation -> Ada Lovelace : funds']) {
    await page.fill('#add-line', line);
    await page.press('#add-line', 'Enter');
    await page.waitForFunction(n => document.querySelectorAll('li.el').length >= n, line.includes('->') ? 3 : line === 'Ada Lovelace' ? 1 : 2);
  }
  check(await page.locator('li.el').count() === 3, 'two typed names plus an arrow line make three names');
  check(await conns('Ada Lovelace').count() === 1 && (await conns('Ada Lovelace').first().innerText()).includes('Acme Foundation'),
    'the arrow line connected Acme to Ada');
  check(await page.evaluate(() => document.activeElement?.id) === 'add-line', 'the cursor stays on the next line for quick entry');

  await page.fill('#add-line', '-> nobody');
  await page.press('#add-line', 'Enter');
  check(await page.isVisible('#toast[data-kind="error"]'), 'a line that isn’t a name or connection explains the syntax');

  // A name that would run script if it were ever treated as HTML.
  await page.fill('#add-line', '<img src=x onerror="alert(1)">');
  await page.press('#add-line', 'Enter');
  await page.waitForSelector('li.el >> text=<img');
  check(await page.locator('.outline img').count() === 0, 'a name containing HTML is shown as text');

  // Open Ada and connect by typing.
  await item('Ada Lovelace').locator('a.name').click();
  await page.waitForSelector('#connect-line');
  check(await page.evaluate(() => document.activeElement?.id) === 'connect-line', 'opening a name puts the cursor on its connection line');
  await page.fill('#connect-line', '-> Gra');
  await page.press('#connect-line', 'Tab');
  check(await page.inputValue('#connect-line') === '-> Grace Hopper', 'Tab completes a name', await page.inputValue('#connect-line'));
  await page.type('#connect-line', ' : mentor');
  await page.press('#connect-line', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('li.el.open .conn').length === 2);
  await page.fill('#connect-line', '<-> City Council : advises');
  await page.press('#connect-line', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('li.el.open .conn').length === 3);
  check(await page.locator('li.el').count() === 5, 'connecting to a new name adds it to the list');
  const arrows = await openItem().locator('.conn .arrow').allInnerTexts();
  check(arrows.join('') === '←→↔', 'each connection shows its direction', arrows.join(''));
  check((await conns('Grace Hopper').allInnerTexts()).some(t => t.includes('Ada Lovelace') && t.includes('mentor')),
    'the connection also appears under the other name');

  // Notes save when you leave the field.
  await page.fill('#element-notes', 'Wrote the first program.');
  await page.click('h1, .title');
  await page.waitForSelector('#toast >> text=Notes saved');
  await page.reload();
  await page.waitForSelector('#element-notes');
  check(await page.inputValue('#element-notes') === 'Wrote the first program.', 'notes are saved');
  await page.screenshot({ path: `${SHOTS}1-project-light.png`, fullPage: true });

  // Clicking a connection opens that name.
  await openItem().locator('.conn a', { hasText: 'Grace Hopper' }).click();
  await page.waitForFunction(() => document.querySelector('li.el.open input.name')?.value === 'Grace Hopper');
  check(true, 'clicking a connection opens that name');

  await page.goto(BASE);
  await page.waitForSelector('.outline a.name');
  await page.screenshot({ path: `${SHOTS}2-projects.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('.outline a.name');
  await page.waitForSelector('li.el');
  await item('Ada Lovelace').locator('a.name').click();
  await page.waitForSelector('#connect-line');
  await page.screenshot({ path: `${SHOTS}3-project-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: `${SHOTS}4-project-phone.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, 'nothing scrolls sideways at phone width', `${overflow}px too wide`);

  for (const font of ['Rock Salt', 'Reenie Beanie', 'Special Elite']) {
    check(await page.evaluate(f => document.fonts.check(`20px "${f}"`), font), `${font} loaded from the site itself`);
  }

  await page.click('text=sign out');
  await page.waitForSelector('#email');
  check(true, 'sign out returns to the sign-in screen');

  check(problems.length === 0, 'no console errors, security-policy violations or dialogs', problems.join(' | '));
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : `\nAll UI checks passed. Screenshots: ${SHOTS}`);
process.exit(failures ? 1 : 0);
