// The push roundtrip is a test hook. It must answer only when KP_TEST is on,
// on the Node handler and on the Worker fetch handler (same module).
import { createRetention } from './retention.js';

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('  ok ' + checks + ' - ' + name);
  else {
    failures += 1;
    console.log('  FAIL ' + checks + ' - ' + name + (extra ? ' :: ' + extra : ''));
  }
}

function mockRes() {
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) { res.status = status; },
    end(body) { res.body = String(body); res.headersSent = true; }
  };
  return res;
}

const off = createRetention({ memory: true, test: false, env: {} });
check('a live shelf does not accept the roundtrip route', off.accepts({ url: '/api/test/push-roundtrip' }) === false);
const offNode = mockRes();
off.handle({ method: 'GET', url: '/api/test/push-roundtrip', headers: {} }, offNode);
await new Promise((resolve) => setImmediate(resolve));
check('the Node handler does not run the roundtrip when the test flag is off', offNode.status === 404, String(offNode.status) + ' ' + offNode.body);

const offFetch = await off.handleFetch(new Request('http://kolopoly.test/api/test/push-roundtrip'));
const offJson = await offFetch.json();
check('the Worker handler does not run the roundtrip when the test flag is off', offFetch.status === 404 && offJson.ok === false, String(offFetch.status));

const on = createRetention({ memory: true, test: true, env: {} });
check('a test shelf accepts the roundtrip route', on.accepts({ url: '/api/test/push-roundtrip' }) === true);
const onNode = mockRes();
on.handle({ method: 'GET', url: '/api/test/push-roundtrip', headers: {} }, onNode);
await new Promise((resolve) => setImmediate(resolve));
check('the Node handler still roundtrips when KP_TEST is on', onNode.status === 200 && JSON.parse(onNode.body).ok === true, onNode.body);
const onFetch = await on.handleFetch(new Request('http://kolopoly.test/api/test/push-roundtrip'));
const onJson = await onFetch.json();
check('the Worker handler still roundtrips when KP_TEST is on', onFetch.status === 200 && onJson.ok === true, JSON.stringify(onJson));

console.log('---');
console.log('checks: ' + checks + ', failures: ' + failures);
process.exit(failures ? 1 : 0);
