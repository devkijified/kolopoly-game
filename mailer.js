'use strict';
// The mail seam: the one door between the game and the post.
// Two transports, picked by the environment, never by the code:
// - Resend, when RESEND_API_KEY is set. Sends through the Resend API
//   from KP_MAIL_FROM (default onboarding@resend.dev).
// - Test transport, when no key is set. It delivers nothing; it logs
//   the mail server-side and keeps an outbox in memory. Tests run on
//   this transport, and a host without a mail key still lets the auth
//   flow be exercised end to end in development.
// No key is ever invented here, and no address is hardcoded beyond the
// documented Resend onboarding sender default.

function createMailer(opts) {
  opts = opts || {};
  const resendKey = opts.apiKey != null ? opts.apiKey : process.env.RESEND_API_KEY;
  const from = opts.from || process.env.KP_MAIL_FROM || 'onboarding@resend.dev';
  const doFetch = opts.fetch || fetch;
  const log = opts.log || ((line) => console.log(line));
  const FAIL = 'The code no send. Nothing was sent. Try again.';
  if (resendKey && String(resendKey).trim() && !opts.forceTest) {
    const key = String(resendKey).trim();
    return {
      name: 'resend',
      testMode: false,
      async sendCode(email, code) {
        try {
          const res = await doFetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from,
              to: [email],
              subject: 'Your Kolopoly sign-in code',
              text: 'Your Kolopoly sign-in code is ' + code + '. It expires in 10 minutes. If you no ask for am, ignore this mail.'
            })
          });
          if (!res.ok) {
            let detail = '';
            try { detail = await res.text(); } catch (e) { detail = ''; }
            log('Resend refused a sign-in mail (' + res.status + '): ' + String(detail || '').replace(/\s+/g, ' ').slice(0, 300));
            return { ok: false, error: 'mail', message: FAIL };
          }
          return { ok: true };
        } catch (e) {
          log('Resend no answer for a sign-in mail: ' + (e && e.message ? e.message : 'network'));
          return { ok: false, error: 'mail', message: FAIL };
        }
      }
    };
  }
  const outbox = [];
  // A host with no mail key must not tell a player the code was sent.
  // The test suite and KP_MAIL_TEST opt into the logged outbox on purpose.
  const pretend = opts.pretend != null ? !!opts.pretend : (process.env.KP_TEST === '1' || process.env.KP_MAIL_TEST === '1');
  return {
    name: 'test',
    testMode: true,
    outbox,
    async sendCode(email, code) {
      outbox.push({ email, code, at: Date.now() });
      log('Kolopoly mail (test transport) to ' + email + ': sign-in code ' + code);
      if (!pretend) {
        log('Sign-in mail is not set up (no RESEND_API_KEY). The player was told to try again.');
        return { ok: false, error: 'mail', message: 'Sign-in mail never set up yet. Nothing was sent. Try again.' };
      }
      return { ok: true };
    }
  };
}

module.exports = { createMailer };
