# Onile on the OVH host

Onile is a second Node process. It does not replace Kolopoly and it does not
edit the game's Caddy site. Give it its own port, its own data directory, and
a new site block for `onile.kolopoly.fun`.

The process reads the Paystack and desk variables Kolopoly already uses.
Do not copy those secrets into git, into this file, or into the journal.

| Variable | Where it comes from |
|---|---|
| `PAYSTACK_SECRET_KEY` | The existing Kolopoly env file. Server only. |
| `KP_ADMIN_TOKEN` | The existing ops desk key. Opens `/admin`. |
| `KP_AUTH_SECRET` | Keeps Onile sign-in cookies across restarts. |
| `KP_PAYOUT_MODE` | `manual` (default) or `auto`, same as the game. |
| `PAYSTACK_API_BASE` | Optional. Leave unset in production. |
| `PORT` | `4180` for this service only. |
| `ONILE_PUBLIC_URL` | `https://onile.kolopoly.fun` |
| `ONILE_DATA_DIR` | `/var/lib/onile` (not Kolopoly's data dir). |
| `ONILE_HOUSE_PERCENT` | Optional. Default `10`. |
| `ONILE_JOIN_HOURS` | Optional. Default `24`. |
| `ONILE_REPORT_HOURS` | Optional. Default `24`. |

`ONILE_DATA_DIR` must not be Kolopoly's data directory. The two apps would
otherwise share `payments.json` and `payouts.json`.

## 1. Service

Run it as a new systemd unit. Point one `EnvironmentFile` at the existing
Kolopoly env file, and a second file at Onile-only settings (`PORT`,
`ONILE_PUBLIC_URL`, `ONILE_DATA_DIR`, `ONILE_HOUSE_PERCENT`). Do not paste
secret values into the unit.

```
# /etc/systemd/system/onile.service
[Unit]
Description=Onile challenge escrow
After=network.target

[Service]
WorkingDirectory=/opt/kolopoly-game
EnvironmentFile=/etc/kolopoly/env
EnvironmentFile=/etc/onile/env
ExecStart=/usr/bin/node onile/server.js
Restart=on-failure
User=kolopoly

[Install]
WantedBy=multi-user.target
```

`/etc/onile/env` only needs the Onile-specific lines, for example:

```
PORT=4180
ONILE_PUBLIC_URL=https://onile.kolopoly.fun
ONILE_DATA_DIR=/var/lib/onile
ONILE_HOUSE_PERCENT=10
```

Then:

```
sudo mkdir -p /var/lib/onile
sudo chown kolopoly:kolopoly /var/lib/onile
sudo systemctl daemon-reload
sudo systemctl enable --now onile
```

Leave port 4180 off the public firewall. Caddy is the only public listener.

Check `GET /api/health`. `payments: true` means the Paystack secret is
present. The response never includes the secret.

## 2. DNS

Add one record for the host `onile` on `kolopoly.fun`, aimed at this same
machine. Do not change the apex or `www` records.

## 3. Caddy

Add a new site file. Do not edit the existing Kolopoly site block.

```
# /etc/caddy/sites/onile.caddy
onile.kolopoly.fun {
	encode gzip
	reverse_proxy 127.0.0.1:4180
}
```

If the main Caddyfile already imports a sites directory, the new file is
enough. If it does not, add a single import line and do not touch any other
site:

```
import /etc/caddy/sites/onile.caddy
```

`sudo caddy validate --config /etc/caddy/Caddyfile` then reload Caddy.

## 4. Paystack

Leave the Kolopoly webhook URL where it is
(`https://kolopoly.fun/api/paystack/webhook`). Onile confirms each payment
with `GET /transaction/verify/:reference` when the player returns, and again
on a sweep. A signed webhook to `https://onile.kolopoly.fun/api/paystack/webhook`
is also accepted. Do not point the existing webhook away from Kolopoly unless
you have a second Paystack business for Onile.

Callback URLs are sent per transaction:
`https://onile.kolopoly.fun/c/CODE`.

Payouts reuse the game's transfer recipient flow. With `KP_PAYOUT_MODE=manual`
the desk presses Send. Each prize transfer uses a reference fixed by the
challenge, so a retry cannot pay it twice. Refunds go back through the
original Paystack transaction. The desk can mark a row paid by hand.

Transfers still need a Paystack business that is allowed to transfer, a
funded balance, and transfer OTP turned off, same as Kolopoly prizes.
