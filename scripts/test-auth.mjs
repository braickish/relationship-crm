// End-to-end checks of the local Supabase sign-in setup. Run with: npm run test:auth
// Needs the local stack running (npx supabase start). Uses the local Mailpit inbox to read magic links.
import { execFileSync } from 'node:child_process';

const status = JSON.parse(execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const API = status.API_URL;
const KEY = status.PUBLISHABLE_KEY || status.ANON_KEY;
const MAIL = status.INBUCKET_URL || status.MAILPIT_URL || 'http://127.0.0.1:54324';

let failures = 0;
const check = (ok, name, detail = '') => {
  console.log(`${ok ? 'ok    ' : 'FAIL  '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
};
const auth = (path, body, token) => fetch(`${API}/auth/v1/${path}`, {
  method: 'POST',
  headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const rest = (path, { method = 'GET', body, token } = {}) => fetch(`${API}/rest/v1/${path}`, {
  method,
  headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
  body: body && JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

// Returns the first link in the newest email to `email`, as the owner would click it.
async function latestLink(email) {
  for (let i = 0; i < 20; i++) {
    const list = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`).then(r => r.json());
    const msg = list.messages?.[0];
    if (msg) {
      const full = await fetch(`${MAIL}/api/v1/message/${msg.ID}`).then(r => r.json());
      const link = (full.Text || '').match(/https?:\/\/\S+\/auth\/v1\/verify\?[^\s)]+/)?.[0];
      if (link) return link;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`No sign-in email arrived for ${email}`);
}

// Follows a sign-in link and returns the access token from the redirect, as the browser would.
async function signInWithLink(link) {
  const r = await fetch(link, { redirect: 'manual' });
  const location = r.headers.get('location') || '';
  return new URLSearchParams(location.split('#')[1] || '').get('access_token');
}

const run = Date.now();
const victim = `victim-${run}@example.com`;
const attackerPassword = 'Correct-Horse-9-Battery';

// 1. An attacker signs up with someone else's email and a password.
const signup = await auth('signup', { email: victim, password: attackerPassword });
check(!signup.body.access_token, 'password sign-up with an unverified email gets no session', JSON.stringify(signup.body).slice(0, 120));

// 2. The attacker tries to sign in with that password.
const early = await auth('token?grant_type=password', { email: victim, password: attackerPassword });
check(!early.body.access_token, 'password sign-in fails before the email is verified', `status ${early.status}`);

// 3. The sign-up just emailed this address, so another email is refused for 60 seconds.
const tooSoon = await auth('otp', { email: victim, create_user: true });
check(tooSoon.status === 429, 'a second email to the same address within 60 seconds is refused', `status ${tooSoon.status}`);
console.log('       waiting 61 seconds for the email limit to reset...');
await new Promise(r => setTimeout(r, 61_000));

// 4. The real owner signs in by clicking the link in their email.
await fetch(`${MAIL}/api/v1/messages`, { method: 'DELETE' });
const otp = await auth('otp', { email: victim, create_user: true });
check(otp.status === 200, 'magic link email is sent', `status ${otp.status} ${JSON.stringify(otp.body)}`);
const token = await signInWithLink(await latestLink(victim));
check(!!token, 'clicking the emailed link signs the owner in');

// 5. The attacker's password must not work now that the email is verified.
const late = await auth('token?grant_type=password', { email: victim, password: attackerPassword });
check(!late.body.access_token, 'the attacker\'s password still fails after the owner verifies', `status ${late.status}`);

// 6. A signed-in user can't set a password either.
await auth('user', {}, token);
const setPw = await fetch(`${API}/auth/v1/user`, {
  method: 'PUT', headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'Another-Password-42' }),
});
const afterSet = await auth('token?grant_type=password', { email: victim, password: 'Another-Password-42' });
check(!afterSet.body.access_token, 'a password set after sign-in is discarded', `update status ${setPw.status}`);

// 7. The data API works for the signed-in owner and is closed to anonymous callers.
const created = await rest('rpc/create_project', { method: 'POST', body: { p_name: 'Smoke test' }, token });
check(created.status === 200 && created.body?.name === 'Smoke test', 'signed-in user can create a project', `status ${created.status}`);
const mine = await rest('projects?select=id,name', { token });
check(mine.status === 200 && mine.body.length === 1, 'signed-in user sees only their own project', `status ${mine.status} rows ${mine.body?.length}`);
const anon = await rest('projects?select=id');
check(anon.status === 401 || anon.status === 403, 'anonymous callers cannot read projects', `status ${anon.status}`);
const anonRpc = await rest('rpc/create_project', { method: 'POST', body: { p_name: 'Nope' } });
check(anonRpc.status === 401 || anonRpc.status === 403, 'anonymous callers cannot create projects', `status ${anonRpc.status}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll auth checks passed');
process.exit(failures ? 1 : 0);
