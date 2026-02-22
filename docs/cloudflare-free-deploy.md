# Cloudflare Free Deploy Guide (Shared Team App)

This deploy target is a **single hosted app** for you and your team, not one instance per developer.

## What gets deployed

- Cloudflare Worker:
  - Web UI dashboard (`/app`)
  - GitHub OAuth login
  - GitHub webhook endpoint (`/webhooks/github`)
  - Queue consumer orchestration
- Cloudflare D1:
  - Runs/findings/patches/events
  - Dashboard users/sessions/settings
- Cloudflare Queues:
  - Async run jobs and ChatOps jobs

## Free-tier intent

This stack is designed for Cloudflare free products (Worker + D1 + Queues) for a small repo set.

Model/API usage is still billed by your model provider.

## One-time setup

1. Authenticate wrangler:

```bash
npx wrangler whoami
```

2. Bootstrap Cloudflare resources:

```bash
pnpm bootstrap:cf
```

3. Update `/Users/mandipadhikari/WorkInProgress/codex-server/services/cloudflare-worker/wrangler.toml`:

- `d1_databases[0].database_id`
- `vars.APP_BASE_URL` (your Worker URL, e.g. `https://pr-guardian-arena.<subdomain>.workers.dev`)
- `vars.GITHUB_OAUTH_CLIENT_ID`
- optional: `vars.GITHUB_APP_SLUG`

4. Apply migrations:

```bash
cd services/cloudflare-worker
npx wrangler d1 migrations apply pr-guardian-arena --remote
```

## GitHub setup required

You need two GitHub integrations:

1. **GitHub App** (for webhook + PR review actions)
2. **GitHub OAuth App** (for dashboard login)

### GitHub App

- Permissions:
  - Pull requests: Read
  - Issues: Read and Write
  - Checks: Read and Write
  - Contents: Read
- Events:
  - Pull request
  - Issue comment
- Webhook URL:
  - `https://<worker-subdomain>.workers.dev/webhooks/github`

### GitHub OAuth App

- Homepage URL: `https://<worker-subdomain>.workers.dev`
- Authorization callback URL: `https://<worker-subdomain>.workers.dev/auth/github/callback`

## Required secrets

From `/Users/mandipadhikari/WorkInProgress/codex-server/services/cloudflare-worker`:

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put OPENAI_API_KEY
```

## Deploy

```bash
pnpm deploy:cf
```

## How your team uses it

1. Open `https://<worker-subdomain>.workers.dev`
2. Click **Login with GitHub**
3. Go to `/app`
4. Select repos from installed GitHub App installations
5. Save runtime settings
6. GitHub webhooks trigger PR runs for active repos

## Runtime controls in dashboard

- Model
- Top patch count per run
- Allowlist override
- Auto-onboard toggle for webhook-first behavior
- Active/inactive repo selection

## Safe defaults for low-cost pilot

- `MAX_REPOS=5`
- `TOP_PATCH_COUNT=3`
- `AUTO_ONBOARD_WEBHOOKS=false`
- Optional explicit `ALLOWED_REPOS`
