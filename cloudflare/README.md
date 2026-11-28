# radar-live (Cloudflare Worker)

Read-only proxy that lets the Radar pages on GitHub Pages read live Kalshi prices and Drafted.gg results.

Deploy without copying code: Cloudflare dashboard → Workers & Pages → Create → Import a repository →
connect GitHub → pick this repository → root directory `cloudflare` → Deploy.

## Automatic data rebuild every 20 minutes

GitHub's own `schedule` often skips hours, so the Worker also has a cron trigger that asks GitHub to run
`nhl-dashboard.yml`:

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   Repository access: **Only select repositories → Condor_bet3.0**. Permissions → Repository → **Contents: Read and write** (the Worker sends a `repository_dispatch` event).
2. Cloudflare → Workers → `radar-live` → Settings → Variables and Secrets → Add → type **Secret**,
   name `GH_TOKEN`, value = the token.
3. Paste the new `worker.js` (Edit code → Deploy).
4. Settings → Trigger events → **Cron Triggers** → Add → `*/20 * * * *`.
