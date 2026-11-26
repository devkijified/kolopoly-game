# How Kolopoly is hosted and deployed

This file is the production truth. It replaces the older notes that
described a Cloudflare cutover and a Render host: neither is where the
players are. Read this before merging anything.

## Production: the OVH box

Production is a single OVH box, `40.160.155.6`. The owner holds the
root SSH key.

- DNS for `kolopoly.fun` and `www.kolopoly.fun` points at the box.
- Caddy on the box proxies both names to `127.0.0.1:4280`.
- The game runs as the systemd unit `kolopoly`:
  `node -r /opt/kolopoly/bind-local.js server.js` with
  WorkingDirectory `/opt/kolopoly/app`.
- Onile runs from the same checkout as the systemd unit `onile`,
  on port 4180.

## Deploy = merge to main

There is no separate deploy step. Merging to `main` is the deploy.

- The `kolopoly-deploy.timer` on the box runs `/opt/kolopoly/deploy.sh`
  every 5 minutes: it fetches `main`, fast-forwards the checkout,
  runs `npm install`, and restarts the services whose code changed.
- The deploy log is `/opt/kolopoly/deploy.log` (UTC).
- To run a deploy by hand on the box:
  `systemctl start kolopoly-deploy.service`.

**Merging restarts live games.** A merge to `main` restarts the
`kolopoly` and `onile` services, and any table in play goes down with
them. Only merge when no games are live, and only with the owner's go.

## Confirming a deploy

Do not confirm a deploy from the `/api/version` build id. The build
ids differ between `server.js` and `worker.js` by design: each hashes
its own `BUILD_FILES` list, and the worker's list adds
`public/game-data.js`. The same code therefore shows different hashes
on the two hosts, and neither hash tells you what the box is running.

To confirm a deploy, read the box: the tail of
`/opt/kolopoly/deploy.log`, or `git log -1` in `/opt/kolopoly/app`.

## The Cloudflare worker is a spare

The Worker (`kolopoly.21stpreneurs.workers.dev`) is a spare and an
experiment, not production:

- The `kolopoly.fun` routes in `wrangler.toml` are commented out.
- DNS points at the OVH box, not at Cloudflare.
- Deploying the worker changes nothing the players get.

It mirrors the game on Durable Objects (each table its own object, a
lobby object for quick play, a third object for the daily shelf) and
stays useful as a fallback host and a test bed. `.github/workflows/
deploy-cloudflare.yml` bundles it on pull requests and deploys it on
pushes to `main` when the repo carries the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` secrets; without them the deploy job prints a
line and exits 0. Worker secrets (the VAPID keys, `KP_ADMIN_TOKEN`,
the optional Supabase pair) belong to the spare only.

If a cutover is ever wanted, it is the reverse of the current state:
uncomment the two `[[routes]]` blocks in `wrangler.toml`, deploy the
worker, and point DNS at Cloudflare. Until then, leave the routes
commented and DNS where it is.

## Render is legacy

`render.yaml` is kept in the repo for history only. No traffic goes
to Render, no deploy targets it, and its dashboard settings change
nothing. Do not follow any older instruction that says to set
variables or redeploy there.

## Local

```sh
npm start                 # Node server, port 4173 or $PORT
npx wrangler dev          # the spare Worker + Durable Objects, local
npm test                  # engine + ops (Node)
npm run test:worker       # Worker path (vitest + miniflare)
```
