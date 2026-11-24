// The installed flag lives on the signed-in account shelf.
// A standalone launch posts it; a later sign-in on Safari can read it.
import { createAuth } from './auth.js';
import { createRetention } from './retention.js';

const auth = createAuth({ secret: 'install-flag-secret' });
const shelf = createRetention({ memory: true, test: true, auth });
let checks = 0, failures = 0;
const check = (name, cond, extra) => {
  checks++;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else { failures++; console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : '')); }
};

const req = auth.requestCode('ada@example.com');
const session = auth.verifyCode('ada@example.com', req.code);
check('a session exists for the flag', !!session.token && !!session.accountId);

const before = await shelf.handleFetch(new Request('http://kolopoly.test/api/auth-not', { method: 'GET' }));
check('an unknown route is not the installed flag', before.status === 404 || before.status === 405);

const denied = await shelf.handleFetch(new Request('http://kolopoly.test/api/account/installed', { method: 'POST', body: '{}' }));
check('the flag refuses a stranger', denied.status === 400);

const saved = await shelf.handleFetch(new Request('http://kolopoly.test/api/account/installed', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ clientId: 'phone-ada-1' })
}));
const savedBody = await saved.json();
check('a signed-in launch marks the account installed', saved.status === 200 && savedBody.installed === true, JSON.stringify(savedBody));
check('the account shelf remembers it', shelf.accountInstalled(session.accountId) === true);

const viewRes = await shelf.handleFetch(new Request('http://kolopoly.test/api/retention?clientId=phone-ada-1&authToken=' + encodeURIComponent(session.token)));
const view = await viewRes.json();
check('the shelf view tells the phone the account is installed', view.ok === true && view.installed === true, JSON.stringify(view));

const other = auth.verifyCode('bola@example.com', auth.requestCode('bola@example.com').code);
check('another account is not installed', shelf.accountInstalled(other.accountId) === false);

console.log(failures ? failures + ' failed' : 'all ' + checks + ' passed');
process.exit(failures ? 1 : 0);
