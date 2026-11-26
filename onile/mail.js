'use strict';
// Onile's own mail door. Winner notices go through Resend when
// RESEND_API_KEY is set, from KP_MAIL_FROM (default onboarding@resend.dev).
// With no key, send() delivers nothing and returns not-ok, unless a test
// opts into the in-memory outbox. No key is invented here.

function createOnileMail(opts) {
  opts = opts || {};
  const resendKey = opts.apiKey != null ? opts.apiKey : process.env.RESEND_API_KEY;
  const from = opts.from || process.env.KP_MAIL_FROM || 'onboarding@resend.dev';
  const doFetch = opts.fetch || fetch;
  const log = opts.log || ((line) => console.log(line));
  if (resendKey && String(resendKey).trim() && !opts.forceTest) {
    const key = String(resendKey).trim();
    return {
      name: 'resend',
      testMode: false,
      async send(mail) {
        const to = String(mail && mail.to || '').trim();
        const subject = String(mail && mail.subject || '').slice(0, 200);
        const text = String(mail && mail.text || '');
        const html = mail && mail.html ? String(mail.html) : undefined;
        if (!to || !subject) return { ok: false, error: 'mail', message: 'Missing mail fields.' };
        try {
          const res = await doFetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to: [to], subject, text, html })
          });
          if (!res.ok) {
            log('Resend refused an Onile mail (' + res.status + ').');
            return { ok: false, error: 'mail', message: 'The mail was not accepted.' };
          }
          return { ok: true };
        } catch (e) {
          log('Resend no answer for an Onile mail.');
          return { ok: false, error: 'mail', message: 'The mail was not sent.' };
        }
      }
    };
  }
  const outbox = [];
  const pretend = opts.pretend != null ? !!opts.pretend : (process.env.KP_TEST === '1' || process.env.KP_MAIL_TEST === '1');
  return {
    name: 'test',
    testMode: true,
    outbox,
    async send(mail) {
      outbox.push({
        at: Date.now(),
        to: mail && mail.to,
        subject: mail && mail.subject,
        text: mail && mail.text,
        html: mail && mail.html
      });
      log('Onile mail (test transport): ' + String(mail && mail.subject || ''));
      if (!pretend) {
        log('Onile mail is not set up (no RESEND_API_KEY). Nothing was sent.');
        return { ok: false, error: 'mail', message: 'Mail never set up yet. Nothing was sent.' };
      }
      return { ok: true };
    }
  };
}

module.exports = { createOnileMail };
