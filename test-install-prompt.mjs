// Install chip: phone only, not during a game, not on the first second,
// and a dismiss stays quiet for 7 days.
import fs from 'fs';
import vm from 'vm';

const context = { window: {}, document: undefined, setInterval() {}, setTimeout() {} };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('./public/install-prompt.js', import.meta.url), 'utf8'), context);
const IP = context.KPInstall;

let n = 0, fail = 0;
function check(name, cond) {
  n += 1;
  if (cond) console.log('  ok ' + n + ' - ' + name);
  else { fail += 1; console.log('  FAIL ' + n + ' - ' + name); }
}

const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const instagram = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0.0.0';
const chromeIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1';
const desktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

check('android is android', IP.device(android) === 'android');
check('iphone safari is ios', IP.device(safari) === 'ios');
check('instagram is an in-app browser', IP.device(instagram) === 'ios-inapp');
check('chrome on iphone is not treated as safari', IP.device(chromeIos) === 'ios-inapp');
check('desktop is desktop', IP.device(desktop) === 'desktop');

const base = {
  ua: android, onLanding: true, hasPrompt: true, now: 100000, landedAt: 100000 - 21000,
  gamesPlayed: 0, snoozeUntil: 0, sessionShown: false, inGame: false, inTraining: false
};
check('android chip after 20 seconds on the landing page', IP.decide(base).show === true && IP.decide(base).kind === 'android');
check('android stays quiet in the first second', IP.decide(Object.assign({}, base, { landedAt: base.now - 500 })).show === false);
check('android can show a second after a finished game', IP.decide(Object.assign({}, base, { gamesPlayed: 1, landedAt: base.now - 1500, hasPrompt: true })).show === true);
check('android without the browser prompt stays quiet', IP.decide(Object.assign({}, base, { hasPrompt: false })).show === false);
check('a live match hides the chip', IP.decide(Object.assign({}, base, { inGame: true })).show === false);
check('training hides the chip', IP.decide(Object.assign({}, base, { inTraining: true })).show === false);
check('standalone hides the chip', IP.decide(Object.assign({}, base, { standalone: true })).show === false);
check('display-mode standalone hides the chip', IP.decide(Object.assign({}, base, { displayMode: 'standalone' })).show === false);
check('a dismiss waits 7 days', IP.decide(Object.assign({}, base, { snoozeUntil: base.now + IP.SNOOZE_MS - 1000 })).show === false);
check('after 7 days it can return', IP.decide(Object.assign({}, base, { snoozeUntil: base.now - 1, sessionShown: false })).show === true);
check('one show per session', IP.decide(Object.assign({}, base, { sessionShown: true, chipOpen: false })).show === false);
check('the open chip is not immediately hidden by the session flag', IP.decide(Object.assign({}, base, { sessionShown: true, chipOpen: true })).show === true);
check('desktop never shows it', IP.decide(Object.assign({}, base, { ua: desktop })).show === false);
check('ios safari gets the chip', IP.decide(Object.assign({}, base, { ua: safari, hasPrompt: false })).kind === 'ios');
check('an in-app browser is told to use safari instead of the share steps', IP.decide(Object.assign({}, base, { ua: instagram, hasPrompt: false })).kind === 'ios-inapp');
check('the snooze is 7 days', IP.snoozeUntil(1000) - 1000 === 7 * 24 * 60 * 60 * 1000);

console.log(fail ? fail + ' failed' : 'all ' + n + ' passed');
process.exit(fail ? 1 : 0);
