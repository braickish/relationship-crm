// Browser smoke test of the production build, Content Security Policy included.
// Run with: npm run test:ui   (needs the local Supabase stack running)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5173/spigots/';
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
  const card = label => page.locator('.cards .card').filter({ has: page.locator('.name', { hasText: nameRe(label) }) }).first();
  const visibleCards = () => page.locator('.cards .card:not([hidden])').count();
  const zone = key => page.locator(`.zone.${key}`);

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

  // A project is one line, and opens on its search.
  await page.fill('#new-project', 'Neighborhood partners');
  await page.press('#new-project', 'Enter');
  await page.waitForSelector('#search');
  check(await page.evaluate(() => document.activeElement?.id) === 'search', 'a new project opens with the cursor on its search line');

  // The search adds what it can't find: names, and connections, with an optional [type] after any name.
  for (const [line, count] of [['Ada Lovelace [person]', 1], ['Grace Hopper', 2], ['Acme Foundation [organization] -> Ada Lovelace : funds', 3]]) {
    await page.fill('#search', line);
    await page.press('#search', 'Enter');
    await page.waitForFunction(n => document.querySelectorAll('.cards .card').length >= n, count);
  }
  check(await page.locator('.cards .card').count() === 3, 'two typed names plus an arrow line make three cards');
  check((await card('Ada Lovelace').locator('.ties').innerText()).includes('Acme Foundation'), 'the arrow line connected Acme to Ada');
  check((await card('Acme Foundation').locator('.type').innerText()).includes('[organization]'), 'a [type] typed in an arrow line is saved');
  check(await page.evaluate(() => document.activeElement?.id) === 'search', 'the cursor stays on the search for quick entry');
  check(await page.inputValue('#search') === '', 'the search is cleared after adding');

  await page.fill('#search', '-> nobody');
  await page.press('#search', 'Enter');
  check(await page.isVisible('#toast[data-kind="error"]'), 'a line that isn’t a name or connection explains the syntax');

  // A name that would run script if it were ever treated as HTML.
  await page.fill('#search', '<img src=x onerror="alert(1)">');
  await page.press('#search', 'Enter');
  await page.waitForSelector('.card >> text=<img');
  check(await page.locator('.cards img').count() === 0, 'a name containing HTML is shown as text');

  await page.fill('#search', 'Grace Hopper -> Babbage : writes to');
  await page.press('#search', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.cards .card').length === 5);

  // Typing filters the cards to matching names; a word inside a name matches too.
  await page.fill('#search', 'hop');
  check(await visibleCards() === 1 && (await page.innerText('.cards .card:not([hidden]) .name')) === 'Grace Hopper', 'the search filters the cards', String(await visibleCards()));
  check(await page.locator('.cards mark').innerText() === 'Hop', 'the matching part of a name is marked');
  check(await page.locator('.card.add').isVisible(), 'a search with no exact match offers to add it');
  await page.fill('#search', 'organization');
  check(await visibleCards() === 1, 'the search matches types too');
  await page.press('#search', 'Escape');
  check(await visibleCards() === 5, 'Escape clears the search and shows every card');

  // Opening a name puts it at the centre of its web. It doesn't grab the cursor; Enter does.
  await page.fill('#search', 'lovel');
  await page.press('#search', 'Enter');
  await page.waitForSelector('.center #element-name');
  check((await page.inputValue('#element-name')).startsWith('Ada Lovelace'), 'Enter on the search opens the top match at the centre');
  check((await zone('up').innerText()).includes('Acme Foundation'), 'what points to a name is upstream of it');
  await page.click('.zone-label');
  check(await page.evaluate(() => document.activeElement?.id) !== 'add-down', 'opening a name doesn’t put the cursor on a connection line');
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => document.activeElement?.id) === 'add-down', 'Enter puts the cursor on the "downstream" line');

  // Where you type sets the direction.
  await page.fill('#add-down', 'Gra');
  await page.press('#add-down', 'Tab');
  check(await page.inputValue('#add-down') === 'Grace Hopper', 'Tab completes a name', await page.inputValue('#add-down'));
  await page.type('#add-down', ' : mentor');
  await page.press('#add-down', 'Enter');
  await page.waitForFunction(() => document.querySelector('.zone.down')?.textContent.includes('Grace Hopper'));
  check((await zone('down').innerText()).includes('mentor'), 'a name typed downstream is pointed to, with its kind');
  check(await page.evaluate(() => document.activeElement?.id) === 'add-down', 'the cursor stays on the line after adding');

  await page.fill('#add-along', 'City Council [government] : advises');
  await page.press('#add-along', 'Enter');
  await page.waitForFunction(() => document.querySelector('.zone.along')?.textContent.includes('City Council'));
  check((await zone('along').locator('.row .arrow').innerText()) === '↔', 'a name typed as mutual is connected both ways');

  await page.fill('#add-up', '-> Babbage : corresponds');
  await page.press('#add-up', 'Enter');
  await page.waitForFunction(() => document.querySelector('.zone.down')?.textContent.includes('Babbage'));
  check(true, 'a typed leading arrow overrides the side it was typed on');
  check(await page.locator('.web-lines path.link').count() === await page.locator('.zone .row').count(), 'a line is drawn to every neighbour');
  check(await page.locator('.web-lines path.stub').count() === 2, 'neighbours with connections of their own show the web carrying on');

  // Clicking an arrow reverses it, and the neighbour moves to the other side.
  await zone('down').locator('.row', { hasText: 'Grace Hopper' }).locator('.arrow').click();
  await page.waitForFunction(() => document.querySelector('.zone.up')?.textContent.includes('Grace Hopper'));
  check(!(await zone('down').innerText()).includes('Grace Hopper'), 'reversing an arrow moves the neighbour to the other side');

  // Renaming takes a [type] too.
  await page.fill('#element-name', 'Ada Lovelace [mathematician]');
  await page.press('#element-name', 'Enter');
  await page.waitForSelector('#toast >> text=Saved');
  await page.waitForFunction(() => document.getElementById('element-name')?.value === 'Ada Lovelace [mathematician]');
  check(true, 'renaming can change the type');

  // Notes save when you leave the field.
  await page.fill('#element-notes', 'Wrote the first program.');
  await page.click('.zone-label');
  await page.waitForSelector('#toast >> text=Notes saved');
  await page.reload();
  await page.waitForSelector('#element-notes');
  check(await page.inputValue('#element-notes') === 'Wrote the first program.', 'notes are saved');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}1-web-light.png`, fullPage: true });

  // Walking: a neighbour moves to the centre and the name you left lands on its other side.
  await zone('up').locator('a.name', { hasText: 'Grace Hopper' }).click();
  await page.waitForFunction(() => document.getElementById('element-name')?.value?.startsWith('Grace Hopper'));
  check((await zone('down').innerText()).includes('Ada Lovelace'), 'the name you left is now beside the new centre');
  check((await page.innerText('.trail')).includes('Ada Lovelace › Grace Hopper'), 'your path through the web is shown');
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('element-name')?.value?.startsWith('Ada Lovelace'));
  check(await page.locator('.trail').count() === 0, 'Back walks the path backwards');
  await page.click('.zone-label');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.cards .card');
  check(await visibleCards() === 6, 'Escape returns to the cards, which show every name');
  check(await page.locator('.card.flash .name').innerText() === 'Ada Lovelace', 'the card you came back from is marked');

  // Opening a card keeps the box the same width, in the same column, under a search that doesn't move.
  const box = sel => page.evaluate(q => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.left, w: r.width, top: r.top + scrollY }; }, sel);
  await page.evaluate(() => scrollTo(0, 0));
  const graceCard = await card('Grace Hopper').evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.left, w: r.width }; });
  const firstCard = await box('.cards .card');
  const searchOnCards = await box('#search');
  await card('Grace Hopper').click();
  await page.waitForSelector('.center');
  await page.waitForTimeout(700);
  const centre = await box('.center');
  const searchInWeb = await box('#search');
  const near = (a, b) => Math.abs(a - b) < 1.5;
  check(near(centre.x, graceCard.x) && near(centre.w, graceCard.w), 'an opened box keeps its width and column', `card ${JSON.stringify(graceCard)}, centre ${JSON.stringify(centre)}`);
  check(near(centre.top, firstCard.top), 'the centre box sits where the first card was', `first card at ${firstCard.top}, centre at ${centre.top}`);
  check(near(searchInWeb.top, searchOnCards.top) && near(searchInWeb.x, searchOnCards.x) && near(searchInWeb.w, centre.w), 'the search stays in place, as wide as the box',
    `${JSON.stringify(searchOnCards)} vs ${JSON.stringify(searchInWeb)}`);

  // The search sits above the web too; typing there goes back to the filtered cards.
  await page.keyboard.press('/');
  check(await page.evaluate(() => document.activeElement?.id) === 'search', '/ jumps to the search');
  await page.keyboard.type('bab');
  await page.waitForSelector('.cards .card:not([hidden])');
  check(await visibleCards() === 1 && await page.inputValue('#search') === 'bab', 'typing in the web’s search shows the matching cards');
  check(await page.evaluate(() => document.activeElement?.id) === 'search', 'the cursor stays in the search while it hands over');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('element-name')?.value?.startsWith('Babbage'));
  check(true, 'Enter opens the match');
  check(problems.length === 0, 'no errors while walking the web', problems.join(' | '));

  await page.goto(BASE);
  await page.waitForSelector('.outline a.name');
  await page.screenshot({ path: `${SHOTS}2-projects.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('.outline a.name');
  await page.waitForSelector('.cards .card');
  await page.screenshot({ path: `${SHOTS}3-cards-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.fill('#search', 'a');
  await page.screenshot({ path: `${SHOTS}3-cards-search.png`, fullPage: true });
  await page.press('#search', 'Escape');
  await page.emulateMedia({ colorScheme: 'dark' });
  await card('Ada Lovelace').click();
  await page.waitForSelector('.center');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}4-web-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}5-web-phone.png`, fullPage: true });
  await page.click('.project-head .title a');
  await page.waitForSelector('.cards .card');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}6-cards-phone.png`, fullPage: true });
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
