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

  const nameRe = label => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\[.*\\])?$`);
  const item = label => page.locator('li.el').filter({ has: page.locator(':scope > a.name', { hasText: nameRe(label) }) }).first();
  const conns = label => page.locator('li.el').filter({ has: page.locator(':scope > a.name', { hasText: nameRe(label) }) }).locator('.conn');
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

  // Names and connections are lines too, with an optional [type] after any name.
  for (const [line, count] of [['Ada Lovelace [person]', 1], ['Grace Hopper', 2], ['Acme Foundation [organization] -> Ada Lovelace : funds', 3]]) {
    await page.fill('#add-line', line);
    await page.press('#add-line', 'Enter');
    await page.waitForFunction(n => document.querySelectorAll('li.el').length >= n, count);
  }
  check(await page.locator('li.el').count() === 3, 'two typed names plus an arrow line make three names');
  check(await conns('Ada Lovelace').count() === 1 && (await conns('Ada Lovelace').first().innerText()).includes('Acme Foundation'),
    'the arrow line connected Acme to Ada');
  check((await item('Acme Foundation').locator('.type').innerText()).includes('[organization]'), 'a [type] typed in an arrow line is saved');
  check(await page.evaluate(() => document.activeElement?.id) === 'add-line', 'the cursor stays on the next line for quick entry');

  await page.fill('#add-line', '-> nobody');
  await page.press('#add-line', 'Enter');
  check(await page.isVisible('#toast[data-kind="error"]'), 'a line that isn’t a name or connection explains the syntax');

  // A name that would run script if it were ever treated as HTML.
  await page.fill('#add-line', '<img src=x onerror="alert(1)">');
  await page.press('#add-line', 'Enter');
  await page.waitForSelector('li.el >> text=<img');
  check(await page.locator('.outline img').count() === 0, 'a name containing HTML is shown as text');

  // Opening a name doesn't grab the cursor; Enter does.
  await item('Ada Lovelace').locator('a.name').click();
  await page.waitForSelector('#connect-line');
  check(await page.evaluate(() => document.activeElement?.id) !== 'connect-line', 'opening a name leaves the cursor where it was');
  check((await page.getAttribute('#connect-line', 'placeholder')).includes('press enter'), 'the connection line reminds you to press Enter');
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => document.activeElement?.id) === 'connect-line', 'Enter puts the cursor on the connection line');

  await page.fill('#connect-line', '-> Gra');
  await page.press('#connect-line', 'Tab');
  check(await page.inputValue('#connect-line') === 'Grace Hopper', 'a typed arrow moves into the arrow column, and Tab completes the name', await page.inputValue('#connect-line'));
  await page.type('#connect-line', ' : mentor');
  const typedLeft = await page.evaluate(() => document.getElementById('connect-line').getBoundingClientRect().left);
  await page.press('#connect-line', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('li.el.open .conn').length === 2);
  const savedLeft = await page.evaluate(() => [...document.querySelectorAll('li.el.open .conn .text a')].find(a => a.textContent === 'Grace Hopper').getBoundingClientRect().left);
  check(Math.abs(typedLeft - savedLeft) < 1.5, 'a new connection lines up with the saved ones', `typed at ${typedLeft}px, saved at ${savedLeft}px`);
  check(await page.evaluate(() => document.activeElement?.id) === 'connect-line', 'the cursor stays on the connection line after adding');

  await page.click('li.el.open .adder .arrow');
  await page.click('li.el.open .adder .arrow');
  await page.fill('#connect-line', 'City Council [government] : advises');
  await page.press('#connect-line', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('li.el.open .conn').length === 3);
  check(await page.locator('li.el').count() === 5, 'connecting to a new name adds it to the list');
  check((await item('City Council').locator('.type').innerText()).includes('[government]'), 'a [type] on a connection line is saved');
  let arrows = await openItem().locator('.conn .arrow').allInnerTexts();
  check(arrows.join('') === '←→↔', 'the arrow chosen by clicking is used', arrows.join(''));
  check((await conns('Grace Hopper').allInnerTexts()).some(t => t.includes('Ada Lovelace') && t.includes('mentor')),
    'the connection also appears under the other name');

  // Clicking a saved arrow cycles its direction.
  await openItem().locator('.conn', { hasText: 'Grace Hopper' }).locator('.arrow').click();
  await page.waitForFunction(() => [...document.querySelectorAll('li.el.open .conn')].find(li => li.textContent.includes('Grace Hopper'))?.querySelector('.arrow').textContent === '←');
  check((await conns('Grace Hopper').first().locator('.arrow').innerText()) === '→', 'reversing an arrow flips it under the other name too');

  // Renaming takes a [type] too.
  await page.fill('#element-name', 'Ada Lovelace [mathematician]');
  await page.press('#element-name', 'Enter');
  await page.waitForSelector('#toast >> text=Saved');
  check(await page.inputValue('#element-name') === 'Ada Lovelace [mathematician]', 'renaming can change the type');

  // Notes save when you leave the field.
  await page.fill('#element-notes', 'Wrote the first program.');
  await page.click('.title');
  await page.waitForSelector('#toast >> text=Notes saved');
  await page.reload();
  await page.waitForSelector('#element-notes');
  check(await page.inputValue('#element-notes') === 'Wrote the first program.', 'notes are saved');
  await page.screenshot({ path: `${SHOTS}1-project-light.png`, fullPage: true });

  // Clicking a connection opens that name.
  await openItem().locator('.conn a', { hasText: 'Grace Hopper' }).click();
  await page.waitForFunction(() => document.querySelector('li.el.open input.name')?.value?.startsWith('Grace Hopper'));
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

  for (const font of ['Zilla Slab', 'Architects Daughter', 'Courier Prime']) {
    check(await page.evaluate(f => document.fonts.check(`700 20px "${f}"`) || document.fonts.check(`20px "${f}"`), font), `${font} loaded from the site itself`);
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
