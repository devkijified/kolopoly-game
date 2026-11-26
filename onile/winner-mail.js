'use strict';
// One mail to the house when a challenge names a winner. Player
// agreement and an admin decision both count. A split or a refund
// does not. The send is recorded on the challenge, so a second pass
// does not send again. A failure is logged and leaves the settlement
// in place; the next sweep tries that challenge once more.

const DEFAULT_ADMIN = 'kijified@gmail.com';

function naira(kobo) {
  const value = Math.abs(Math.round(Number(kobo) || 0));
  const whole = Math.floor(value / 100);
  const frac = value % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '₦' + grouped + (frac ? '.' + String(frac).padStart(2, '0') : '');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function cleanEmail(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t || t.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return null;
  return t;
}
function deskUrl(publicUrl, code) {
  const base = String(publicUrl || 'https://onile.kolopoly.fun').replace(/\/+$/, '');
  return base + '/admin?code=' + encodeURIComponent(code);
}
function winnerLetter(notice, link) {
  const winner = notice.winner && notice.winner.name ? notice.winner.name : 'The winner';
  const players = (notice.players || []).map((p) => p.name).filter(Boolean).join(', ') || 'None';
  const pct = notice.housePercent != null ? notice.housePercent : 10;
  const bank = notice.bankOnFile ? 'yes' : 'no';
  const subject = 'Onile: winner confirmed · ' + notice.code + ' · ' + naira(notice.prizeKobo);
  const lines = [
    notice.title + ' (' + notice.code + ')',
    'Stake each: ' + naira(notice.stakeKobo),
    'Players: ' + players,
    'Winner: ' + winner,
    'Pot held: ' + naira(notice.potKobo),
    'House cut (' + pct + '%): ' + naira(notice.houseKobo),
    'Payout: ' + naira(notice.prizeKobo),
    'Bank details on file: ' + bank,
    'Onile is holding the pot in escrow. The winner is confirmed, so the payout can leave escrow.',
    'Open this challenge on the house desk: ' + link
  ];
  const row = (label, value) => '<tr><td style="padding:4px 12px 4px 0;color:#5c4d40;">' + esc(label) + '</td><td style="padding:4px 0;font-weight:700;">' + esc(value) + '</td></tr>';
  const html = '<div style="font-family:Figtree,sans-serif;color:#1b140f;line-height:1.4;">' +
    '<p style="margin:0 0 12px;">Onile is holding the pot in escrow. The winner is confirmed, so the payout can leave escrow.</p>' +
    '<table style="border-collapse:collapse;">' +
    row('Challenge', notice.title) +
    row('Code', notice.code) +
    row('Stake each', naira(notice.stakeKobo)) +
    row('Players', players) +
    row('Winner', winner) +
    row('Pot held', naira(notice.potKobo)) +
    row('House cut (' + pct + '%)', naira(notice.houseKobo)) +
    row('Payout', naira(notice.prizeKobo)) +
    row('Bank details on file', bank) +
    '</table>' +
    '<p style="margin:16px 0;"><a href="' + esc(link) + '" style="display:inline-block;background:#ffc400;color:#1b140f;text-decoration:none;font-weight:800;padding:12px 16px;border-radius:12px;border:3px solid #1b140f;">Open this challenge</a></p>' +
    '</div>';
  return { subject, text: lines.join('\n'), html };
}

function createWinnerMail(opts) {
  opts = opts || {};
  const escrow = opts.escrow;
  const payouts = opts.payouts;
  const mailer = opts.mailer;
  const log = opts.log || ((line) => console.log(line));
  const fromEnv = opts.adminEmail != null ? opts.adminEmail : process.env.ONILE_ADMIN_EMAIL;
  const adminEmail = cleanEmail(fromEnv) || DEFAULT_ADMIN;
  const publicUrl = opts.publicUrl || process.env.ONILE_PUBLIC_URL || 'https://onile.kolopoly.fun';
  const inflight = new Set();
  let running = false;
  let again = false;

  function bankOnFile(accountId) {
    if (!accountId || !payouts || typeof payouts.mine !== 'function') return false;
    try {
      const mine = payouts.mine(accountId);
      return !!(mine && mine.bank);
    } catch (e) {
      return false;
    }
  }
  async function deliver(notice) {
    const link = deskUrl(publicUrl, notice.code);
    const letter = winnerLetter(Object.assign({}, notice, { bankOnFile: bankOnFile(notice.winner && notice.winner.id) }), link);
    if (!mailer || typeof mailer.send !== 'function') return { ok: false, error: 'mail' };
    return mailer.send({ to: adminEmail, subject: letter.subject, text: letter.text, html: letter.html });
  }
  async function flush() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const rows = escrow.pendingWinnerNotices();
        for (const notice of rows) {
          if (inflight.has(notice.code)) continue;
          inflight.add(notice.code);
          try {
            const sent = await deliver(notice);
            if (sent && sent.ok) escrow.markWinnerMailed(notice.code);
            else log('Onile winner mail was not sent for ' + notice.code + '. The settlement stands.');
          } catch (e) {
            log('Onile winner mail failed for ' + notice.code + '. The settlement stands.');
          } finally {
            inflight.delete(notice.code);
          }
        }
      } while (again);
    } finally {
      running = false;
    }
  }
  function kick() {
    setImmediate(() => { flush().catch(() => {}); });
  }
  return { flush, kick, adminEmail, winnerLetter, deskUrl: (code) => deskUrl(publicUrl, code) };
}

module.exports = { createWinnerMail, winnerLetter, deskUrl, naira, DEFAULT_ADMIN };
