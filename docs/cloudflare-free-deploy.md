# Cloudflare + GitHub Actions Deploy Guide (Strict Codex App Server)

This setup keeps Cloudflare as the shared control plane and uses GitHub Actions runners for strict `codex app-server` execution.

## Architecture

1. Cloudflare Worker:
- Dashboard (`/`, `/app`)
- GitHub OAuth login
- Webhook ingestion (`/webhooks/github`)
- Queue + run orchestration
- D1 persistence

2. GitHub Actions runner:
- Triggered by Worker via workflow dispatch
- Runs `codex app-server` with:
  - `thread/start`
  - `thread/fork`
  - `review/start`
  - `turn/start`
- Posts check/comment to PR
- Calls Worker callback endpoint (`/internal/app-server/callback`)

3. Cloudflare D1:
- Runs, findings, patches, events
- Dashboard users/sessions/settings

## Cost model

1. Cloudflare: free-tier friendly for Worker, D1, Queue usage at small scale.
2. GitHub Actions: uses your Actions minutes unless you use self-hosted runners.
3. Model usage: billed by your model provider.

## One-time setup

1. Wrangler login:

```bash
npx wrangler whoami
```

2. Bootstrap Worker resources:

```bash
pnpm bootstrap:cf
```

3. Apply D1 migrations:

```bash
cd services/cloudflare-worker
npx wrangler d1 migrations apply pr-guardian-arena --remote
```

## Configure `wrangler.toml`

Update `/Users/mandipadhikari/WorkInProgress/codex-server/services/cloudflare-worker/wrangler.toml`:

1. `d1_databases[0].database_id`
2. `vars.APP_BASE_URL`
3. `vars.GITHUB_OAUTH_CLIENT_ID`
4. `vars.EXECUTION_MODE=app_server_actions`
5. `vars.ACTIONS_REPO_OWNER`
6. `vars.ACTIONS_REPO_NAME`
7. `vars.ACTIONS_WORKFLOW_ID=pr-guardian-app-server-runner.yml`
8. `vars.ACTIONS_WORKFLOW_REF` (default branch for workflow dispatch)

## Required Worker secrets

From `/Users/mandipadhikari/WorkInProgress/codex-server/services/cloudflare-worker`:

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ACTIONS_DISPATCH_TOKEN
npx wrangler secret put INTERNAL_CALLBACK_SECRET
```

Notes:
1. `ACTIONS_DISPATCH_TOKEN` should be a token that can call `workflow_dispatch` on your control repo.
2. `INTERNAL_CALLBACK_SECRET` must match GitHub repository secret `PGA_INTERNAL_CALLBACK_SECRET`.

## GitHub requirements

You need:

1. GitHub App (for PR checks/comments + webhook)
2. GitHub OAuth App (dashboard login)
3. GitHub Actions workflow in control repo:
- `/Users/mandipadhikari/WorkInProgress/codex-server/.github/workflows/pr-guardian-app-server-runner.yml`

### GitHub App permissions

1. Pull requests: Read
2. Issues: Read and write
3. Checks: Read and write
4. Contents: Read
5. Events:
- Pull request
- Issue comment

### GitHub OAuth App

1. Homepage URL: `https://<worker>.workers.dev`
2. Callback URL: `https://<worker>.workers.dev/auth/github/callback`

### Control repo Actions secrets

In the repo that contains `pr-guardian-app-server-runner.yml`, add:

1. `GITHUB_APP_ID`
2. `GITHUB_APP_PRIVATE_KEY`
3. `OPENAI_API_KEY`
4. `PGA_INTERNAL_CALLBACK_SECRET`

## Deploy

```bash
pnpm deploy:cf
```

## Runtime flow check

1. Open `https://<worker>.workers.dev`
2. Login with GitHub
3. Select active repos in `/app`
4. Open/update a PR in active repo
5. Worker enqueues run and dispatches Actions workflow
6. Workflow completes Codex App Server run and posts PR report
7. Callback persists findings/patches in D1

## Low-cost defaults

1. `MAX_REPOS=5`
2. `TOP_PATCH_COUNT=3`
3. `AUTO_ONBOARD_WEBHOOKS=false`
4. Optional allowlist via `ALLOWED_REPOS`
