'use strict';
// The payment seam inside the game host: how a seat gets marked paid.
// Three modes, picked by the host (server.js, worker.js), never by the
// client:
// - test: the provider confirms every seat after a short delay and
//   marks the confirmation testMode. Tests and development run here.
//   No real money can move in this mode.
// - redirect: real Paystack is set up on this host. A seat is never
//   paid through the socket in this mode; the client opens the
//   Paystack page through POST /api/payments/initialize and the seat
//   settles from the webhook, a verify call, or the reconcile sweep.
//   paySeat here only explains that, and refuses.
// - off: no payment keys are set up on this host. Paid rooms can be
//   created and joined (with an account), but paySeat refuses with
//   the not-set-up message, and the client shows the same state.
// Real collection additionally requires the signed-in account the
// game host checks before it ever reaches this seam.

function createTestProvider(opts) {
  opts = opts || {};
  const delayMs = opts.delayMs != null ? opts.delayMs : 400;
  let counter = 0;
  return {
    name: 'test',
    mode: 'test',
    testMode: true,
    enabled: true,
    paySeat(info) {
      counter += 1;
      const ref = 'test-' + Date.now().toString(36) + '-' + counter;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            ok: true,
            ref,
            testMode: true,
            amount: info.amount,
            message: 'Test payment confirmed. No real money move.'
          });
        }, delayMs);
      });
    }
  };
}

function createRedirectProvider() {
  return {
    name: 'paystack',
    mode: 'redirect',
    testMode: false,
    enabled: true,
    paySeat() {
      return Promise.resolve({
        ok: false,
        error: 'redirect',
        message: 'Use the Pay button to open the Paystack page. Your seat go mark paid when Paystack confirm.'
      });
    }
  };
}

function createOffProvider() {
  return {
    name: 'none',
    mode: 'off',
    testMode: false,
    enabled: false,
    paySeat() {
      return Promise.resolve({
        ok: false,
        error: 'not-set-up',
        message: 'Payments never set up yet. The paid table dey wait for the house to finish the setup.'
      });
    }
  };
}

// Legacy picker, kept for hosts that have not chosen a mode yet: an
// explicit provider wins, then an explicit mode, then test mode when
// asked, then redirect when a secret key exists, else off.
function createPayProvider(opts) {
  opts = opts || {};
  if (opts.provider) return opts.provider;
  if (opts.mode === 'test') return createTestProvider(opts);
  if (opts.mode === 'redirect') return createRedirectProvider();
  if (opts.mode === 'off') return createOffProvider();
  if (opts.test || opts.forceTest) return createTestProvider({ delayMs: opts.delayMs != null ? opts.delayMs : 10 });
  const secretKey = opts.secretKey != null ? opts.secretKey : process.env.PAYSTACK_SECRET_KEY;
  if (secretKey && String(secretKey).trim()) return createRedirectProvider();
  return createOffProvider();
}

module.exports = { createPayProvider, createTestProvider, createRedirectProvider, createOffProvider };
