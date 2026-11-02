# Kolopoly on Cloudflare (free plan)

The live host is a Worker plus three Durable Objects on the SQLite backend.
Static files in `public/` are served from the assets CDN. Each table is its
own object. A lobby object matches quick play. The daily shelf (cowries,
kola, yams, cloth, and whisper subscriptions) lives in a third object.
Idle tables hibernate: no `setInterval`, no always-on process, no sleep
after 15 minutes, and no monthly hour cap.

`npm start` still runs the Node server. `render.yaml` is the old host. Leave
it in the repo; do not point DNS at it once the nameservers below are live.

## What you need

- A free Cloudflare account.
- The domain `kolopoly.fun` (DNS today is at Hostinger: apex `A` `216.24.57.1`, `www` `CNAME` `kolopoly-game.onrender.com`).
- GitHub secrets on this repo, added after the token exists:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`

Worker secrets (not GitHub) hold the push keys, the ops desk key, and the
optional match-record store. They are set with `wrangler secret put` below.

## 1. Create the Cloudflare account and add the domain

1. Sign up at https://dash.cloudflare.com/sign-up (Free plan).
2. Add a site. Enter `kolopoly.fun`. Choose the **Free** plan.
3. Cloudflare will import the Hostinger records. You should see:
   - `kolopoly.fun` `A` `216.24.57.1`
   - `www` `CNAME` `kolopoly-game.onrender.com`
   Leave those in place until the Worker custom domains exist (step 6). They
   are what the site uses until nameservers switch and the Worker routes
   are turned on.
4. Cloudflare shows two nameservers, like `ada.ns.cloudflare.com` and
   `bob.ns.cloudflare.com`. Copy both.

## 2. Point Hostinger at those nameservers

1. Hostinger → Domains → `kolopoly.fun` → DNS / Nameservers.
2. Switch from Hostinger nameservers to **custom nameservers**.
3. Paste the two Cloudflare nameservers. Save.
4. Back in Cloudflare, wait until the site status is **Active**. This often
   takes a few minutes and can take a few hours. Mail and other records
   Cloudflare imported keep working; only the nameserver host changes.

## 3. Create an API token (smallest scope that can deploy)

Dash → My Profile → API Tokens → Create Token → start from **Edit Cloudflare Workers**, then tighten it:

| Scope | Permission |
| --- | --- |
| Account → Workers Scripts | Edit |
| Account → Account Settings | Read |
| Zone → Workers Routes | Edit |
| Zone → DNS | Edit |
| Zone → Zone | Read |

Zone resources: **Include → Specific zone → kolopoly.fun** only.
Account resources: this account only.

DNS Edit is there so a later custom-domain deploy can write the proxied
records. The token cannot touch other zones. Copy the token once. Do not
commit it. Do not put it in `wrangler.toml`.

The account id is on the Workers overview (or the domain overview sidebar):
a 32-character hex string.

## 4. GitHub secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

- `CLOUDFLARE_API_TOKEN` = the token from step 3
- `CLOUDFLARE_ACCOUNT_ID` = the account id

`.github/workflows/deploy-cloudflare.yml` deploys on every push to `main`.
If either secret is missing, the job prints a line and exits 0. It does not
fail the build. The same workflow runs `wrangler deploy --dry-run` on pull
requests and on main, using Node 22. Wrangler 4.156 and later refuse to
start on Node 20. The Worker path needs Node 22 (`engines.node` in
`package.json`). `npm start` is the same server code and does not call Wrangler.

The old keep-warm workflow no longer pings Render. Workers do not sleep.

## 5. First deploy (workers.dev, before the domain moves)

On your machine, from this repo:

Wrangler 4.156+ needs Node 22. Check with `node -v` before deploying.

```sh
npm install
npx wrangler login
npx wrangler deploy --dry-run   # bundles only; catches a broken module rule
npx wrangler deploy
```

`wrangler.toml` does **not** attach `kolopoly.fun` yet (those routes are
commented). The deploy prints a `*.workers.dev` URL. Open it, create a
room, and play a turn before you cut DNS.

## 6. Attach kolopoly.fun and www

When the zone is Active:

1. In `wrangler.toml`, uncomment the two `[[routes]]` blocks (`kolopoly.fun`
   and `www.kolopoly.fun`, both `custom_domain = true`).
2. `npx wrangler deploy` again.

Cloudflare creates proxied DNS records for both names and issues the
certificates. In the DNS tab, delete the leftover Hostinger records if
they are still present and conflicting:

- the apex `A` `216.24.57.1`
- the `www` `CNAME` `kolopoly-game.onrender.com`

The custom-domain records replace them. Both names serve this Worker.
`www` does not redirect; it is the same game.

## 7. Worker secrets

From the repo, each command prompts for the value. Nothing is written to git.

```sh
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put KP_ADMIN_TOKEN
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Generate the push keys locally with `npm run vapid`. `VAPID_SUBJECT` must
be `mailto:you@domain` or an `https://` URL. Keep the same key pair forever
or every phone must allow whispers again.

`KP_ADMIN_TOKEN` is the ops desk key (`/ops`). Until it is set, the desk
stays shut.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are optional. If either is
missing, finished-game records are a no-op and `GET /api/records` returns
`enabled: false`. The table still plays. The SQL for the table is
`migrations/001_kolopoly_matches.sql`.

After `secret put`, Wrangler redeploys. Open tables stay up: their state is
in the Durable Object, not in the process that just restarted.

Check:

- `GET /api/version` returns `ok`, a 12-character build, and `edge: true`.
- `GET /api/push/vapid` returns `enabled: true` and the public key only.
- `GET /ops` shows the house-key gate, and the landing page does not link it.

## Local

```sh
npm start                 # Node fallback, port 4173 or $PORT
npx wrangler dev          # Worker + Durable Objects on localhost
npm test                  # engine + ops (Node)
npm run test:worker       # Worker path (vitest + miniflare)
```

`wrangler dev` uses the same `worker.js`. Set secrets for local with
`.dev.vars` (gitignored by Wrangler) or `npx wrangler secret` is production
only. A `.dev.vars` file looks like:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@domain
KP_ADMIN_TOKEN=...
```

Do not commit `.dev.vars`.

## How a table is routed

The stamped page sets `window.KOLOPOLY_EDGE`. The browser then opens
`/lobby` or `/room/CODE`. The lobby only allocates a code (`switch_room`).
The room object runs the game. Gameplay messages are the same ones the Node
server speaks. The Node server ignores the path, and it never sends
`switch_room`, so `npm start` and the old test client are unchanged.

Quick play asks the lobby for a waiting public lobby **of the mode the
player picked**. Classic never sits down in an Inflation lobby. A missing
pick is Inflation.

## Free-plan headroom

Published free limits this host is built for:

- 100,000 Worker requests / day
- 100,000 Durable Object requests / day
- 20 incoming WebSocket messages count as 1 Durable Object request
- about 13,000 GB-s / day. At the 128 MB object size that is roughly
  **28 object-hours** if an object stayed resident the whole time

Hibernation is what makes a quiet table free. The object sleeps while its
sockets stay open. State is in SQLite storage. The next message or alarm
wakes it. There is no 500ms loop.

What still spends the budget:

- A foreground tab sends a heartbeat about every 15 seconds. That is about
  **12 Durable Object requests per active player-hour** (240 messages / 20).
- Turn timers, auctions, AFK warnings, phase horns, and bot think times are
  one alarm each. A busy table adds a few dozen alarms an hour. Small next
  to heartbeats.
- The lobby is touched when a seat is created, joined, or the table changes,
  not on heartbeats.
- `/api/version` is polled every 60s on the landing screen and every 120s
  at the table. That is a Worker request. JS, CSS, fonts, and images are
  served by the asset CDN and do not spend that quota.
- A tab left open at the table is about 30 version requests an hour, so
  **about 3,000 tab-hours / day** fills the Worker request cap if nothing
  else is calling the Worker. Landing tabs poll twice as often.

Planning number with margin: **about 4,000 active player-hours a day**
(for example ~150 people playing at once across a day, or a few hundred
through an evening). Idle rooms with nobody connected and no pending alarm
cost nothing. A room in the grace window (10 minutes, or 3 seconds when
`KP_TEST=1`) holds a single alarm, then deletes itself.

If the version poll or the heartbeat ever becomes the thing that hits the
cap first, lengthen those intervals. Do not turn hibernation off and do
not put `setInterval` back inside a room object.

## What is different from the Node server

- A deploy or an eviction does not wipe open tables. The client still
  reconnects with `rejoin`. `rejoin_failed` means the room is actually gone
  (grace expired, or the token is wrong), not that the process restarted.
- Timers fire from an alarm at the deadline. The Node server polls every
  500ms, so the Worker is on time rather than up to half a second late.
- Bot think times use the same windows, driven by the alarm instead of
  `setTimeout`, so a bot does not keep the object awake.
- The shelf is Durable Object storage. `KP_RETENTION_FILE` applies only to
  Node.
- Push signatures use WebCrypto. The same `VAPID_*` values work. In
  `KP_TEST` the Worker uses a fixed test key pair so the public key is
  stable; Node still generates a fresh pair per process.
- Ops uptime is how long the lobby object has been awake since it last
  hibernated. The room list and the shelf counts survive.
- The edge page connects on `/lobby` and `/room/CODE` and understands
  `switch_room`. That message is not sent by Node.
