# Play to Earn: how the money moves

The Lagos paid table: every seat pays ₦200 through Paystack, the winner gets
90 percent of the pot, the house keeps 10. All money numbers are computed on
the server in kobo; the client never sends an amount.

## The flow

1. **Sign in.** Paid tables need the email account (the sign-in gate).
2. **Seat.** The player creates or joins a Lagos room. Bots never sit at a
   paid table.
3. **Pay.** `POST /api/payments/initialize` (Bearer account token, `{roomCode}`)
   opens a Paystack transaction: amount `fee × 100` kobo (20000), currency
   `NGN`, a server-made reference `kp…`, metadata `{roomCode, playerId,
   accountId, cityId}`, callback `KP_PUBLIC_URL/?paid=CODE`. A second tap
   reuses the open payment; a stale one is re-verified and replaced.
4. **Confirm.** A seat is marked paid only by the server's settle funnel, fed
   by three witnesses: the signed webhook (HMAC SHA512 of the raw body with the
   secret key, constant-time compare), verify on return (`GET
   /api/payments/status`, which asks Paystack `GET /transaction/verify/:ref`),
   and the reconcile sweep for payments nobody came back for. A reference
   settles once. The amount and currency must match to the kobo.
   Paystack reports an opened-but-unpaid payment as `abandoned`, so that alone
   never closes a payment; it closes after `KP_PAY_EXPIRE_MS` (45 minutes). A
   success that lands late still settles.
5. **Play.** The host starts once every seat has paid. A paid game always runs
   on the 60 minute match clock, and **the host cannot end it early**; it ends by
   the clock, the Final Reckoning horn, or the last landlord standing. If
   every player walks away, it ends the way the clock would (richest seat wins).
6. **Settle.** At the end, the prize is priced from the fee and share
   snapshotted at the start: pot `fee × 100 × seats` kobo, winner
   `floor(pot × share / 100)`, house the rest. Prize and house entries go to the
   append-only prize ledger, and the prize becomes a payout row.
7. **Collect.** The winner taps *Collect to my bank* on the final table (or
   *My winnings* in the Play to Earn sheet), picks the bank and types the
   10-digit account number. Paystack resolves the account name, and the server
   saves a transfer recipient. Only the bank name, the account name and the
   last four digits are kept.
8. **Pay out.** The ops desk (`/ops`, *Play to Earn money*) shows every
   payment, every payout row and the house take. With the default
   `KP_PAYOUT_MODE=manual`, the desk presses **Send** (Paystack `POST
   /transfer`). With `auto`, ready rows send by themselves. Each prize transfer
   carries a reference fixed by the row, so a retry, a double tap or a crash can
   never pay twice. A row is saved as `sending` before the call, and the sweep
   asks `GET /transfer/verify/:ref` about anything left there. The transfer
   webhooks (`transfer.success`, `failed`, `reversed`) close rows too.

## When the money is owed back

| Case | What happens |
|---|---|
| Seat leaves a paid lobby | refund row against that payment |
| Room dies before the start | refund rows for every paid seat |
| Payment confirms after the seat is gone | refund row (`no-seat`) |
| Wrong amount or currency | never seats, refund row (`wrong-amount`) |
| Server restart or redeploy with a paid lobby or a running game | refund rows at boot (`restart`), once |
| Winner seat still held by the AFK bot at the end | prize row held in `review`. The desk approves it or pays by hand. |

Refunds go back through the original transaction (Paystack `POST /refund`),
and `refund.processed` closes them. *Mark paid* records money moved by hand.

## Render environment

| Variable | Needed | Notes |
|---|---|---|
| `PAYSTACK_SECRET_KEY` | yes | `sk_live_…` (or `sk_test_…` to rehearse). Server only. |
| `KP_AUTH_SECRET` | yes | long random string, so sign-in sessions survive restarts |
| `RESEND_API_KEY` | yes | sends the sign-in codes |
| `KP_MAIL_FROM` | yes | a sender on a domain verified in Resend, e.g. `Kolopoly <play@kolopoly.fun>`. The default `onboarding@resend.dev` only delivers to the Resend account owner, so other players never get their code. |
| `KP_ADMIN_TOKEN` | yes | opens `/ops` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | yes on Render free | durable copy of payments, ledger, payouts. Run `migrations/002_kolopoly_kv.sql` once. |
| `KP_PUBLIC_URL` | optional | defaults to `https://kolopoly.fun` (the callback base) |
| `KP_PAYOUT_MODE` | optional | `manual` (default) or `auto` |
| `KP_DATA_DIR` | optional | point at a mounted disk on a paid plan |

No public key is needed: the client redirects to Paystack's hosted page.

## Paystack dashboard

- **Settings → API Keys & Webhooks → Live Webhook URL:**
  `https://kolopoly.fun/api/paystack/webhook`
- **Callback URL:** leave it empty. The server sends one with every
  transaction (`https://kolopoly.fun/?paid=CODE`).
- **Transfers:** prizes need a business that is verified for transfers (a
  registered business, not a Starter account), with a funded balance. Turn
  off **Settings → Preferences → Transfers → confirm transfers with OTP**, or
  every transfer stops at `otp` and must be finished in the dashboard. Until
  transfers are approved, the desk still shows each prize as owed. Pay it from
  the bank app and press *Mark paid*.
- **Refunds** work on any live business.
