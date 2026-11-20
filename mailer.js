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
  if (resendKey && String(resendKey).trim() && !opts.forceTest) {
    const key = String(resendKey).trim();
    return {
      name: 'resend',
      testMode: false,
      async sendCode(email, code) {
        try {
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from,
              to: [email],
              subject: 'Your Kolopoly sign-in code',
              text: 'Your Kolopoly sign-in code is ' + code + '. It expires in 10 minutes. If you no ask for am, ignore this mail.'
            })
          });
          return { ok: !!res.ok };
        } catch (e) {
          return { ok: false };
        }
      }
    };
  }
  const outbox = [];
  return {
    name: 'test',
    testMode: true,
    outbox,
    async sendCode(email, code) {
      outbox.push({ email, code, at: Date.now() });
      console.log('Kolopoly mail (test transport) to ' + email + ': sign-in code ' + code);
      return { ok: true };
    }
  };
}

module.exports = { createMailer };
