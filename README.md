# PR Guardian Arena

GitHub-first PR copilot with two deployment targets:

- Node stack (Fastify + BullMQ + Postgres + Redis + Codex App Server)
- Cloudflare hybrid stack (Worker control plane + Queues + D1 + GitHub Actions Codex App Server runner)

## What This Implements

- `POST /webhooks/github` for `pull_request` and `issue_comment` events
- Queue-driven worker pipeline
- 3 persona review flow: correctness, security, maintainability
- Finding dedupe/rank and consolidated PR comment
- Patch suggestion generation
- ChatOps commands:
  - `/codex rerun [correctness|security|maintainability|all]`
  - `/codex explain <finding_id>`
  - `/codex patch <finding_id>`
  - `/codex stop`
- Internal endpoints:
  - `POST /internal/runs/:runId/retry`
  - `POST /internal/runs/:runId/cancel`
  - `POST /internal/app-server/callback`
- Dashboard control plane (Cloudflare target):
  - `GET /` landing + login
  - `GET /app` settings + repo onboarding UI
  - `POST /app/settings`
  - `POST /app/repos/sync`

## Monorepo Layout

- `services/web`: webhook + API service
- `services/worker`: BullMQ worker and Codex orchestration
- `services/cloudflare-worker`: Cloudflare Worker + Queue consumer + D1 store
- `packages/domain`: ranking/dedupe/chatops/diff logic
- `packages/app-server-client`: stdio JSON-RPC client for `codex app-server`
- `packages/common`: env, DB store, queue contracts, GitHub app auth
- `.github/workflows/pr-guardian-app-server-runner.yml`: strict Codex App Server execution runner
- `db/migrations`: Postgres schema migrations

## Prerequisites

- Node.js 22+
- pnpm 10+
- GitHub App credentials + webhook secret

For Node target:

- `codex` CLI available in `$PATH`
- Postgres
- Redis

For Cloudflare target:

- Cloudflare account
- Wrangler auth (`npx wrangler whoami`)
- D1 database + Queue created in Cloudflare
- GitHub OAuth App credentials (for dashboard login)
- GitHub Actions enabled in the control repo

## Local Setup (Node Target)

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Run migrations:

```bash
pnpm migrate
```

4. Start web + worker (separate shells):

```bash
pnpm dev:web
pnpm dev:worker
```

## Cloudflare Setup (Free-Tier Friendly)

1. Authenticate Wrangler:

```bash
npx wrangler whoami
```

If not logged in:

```bash
npx wrangler login
```

2. Create D1 database and Queue (one-time):

```bash
cd services/cloudflare-worker
npx wrangler d1 create pr-guardian-arena
npx wrangler queues create pr-guardian-runs
```

Or run the helper script from repo root:

```bash
pnpm bootstrap:cf
```

3. Update `services/cloudflare-worker/wrangler.toml` with the real `database_id`.

4. Apply D1 migrations remotely:

```bash
npx wrangler d1 migrations apply pr-guardian-arena --remote
```

5. Set required secrets:

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ACTIONS_DISPATCH_TOKEN
npx wrangler secret put INTERNAL_CALLBACK_SECRET
```

Set `vars` in `services/cloudflare-worker/wrangler.toml`:

- `APP_BASE_URL`
- `GITHUB_OAUTH_CLIENT_ID`
- optional `GITHUB_APP_SLUG`
- `EXECUTION_MODE` (`app_server_actions` for strict App Server)
- `ACTIONS_REPO_OWNER`, `ACTIONS_REPO_NAME`
- `ACTIONS_WORKFLOW_ID`, `ACTIONS_WORKFLOW_REF`
- `MAX_REPOS`, `TOP_PATCH_COUNT`, `ALLOWED_REPOS`, `AUTO_ONBOARD_WEBHOOKS`, `SESSION_TTL_DAYS`

For local worker dev, copy `services/cloudflare-worker/.dev.vars.example` to `services/cloudflare-worker/.dev.vars` and fill values.

6. Deploy:

```bash
pnpm deploy:cf
```

7. Configure GitHub App webhook URL:

```text
https://<your-worker-subdomain>.workers.dev/webhooks/github
```

8. Configure GitHub OAuth app callback:

```text
https://<your-worker-subdomain>.workers.dev/auth/github/callback
```

9. In the GitHub Actions control repo, set workflow secrets:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `OPENAI_API_KEY`
- `PGA_INTERNAL_CALLBACK_SECRET` (must match Worker `INTERNAL_CALLBACK_SECRET`)

## Validation

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Cloudflare Commands

```bash
pnpm dev:cf
pnpm deploy:cf
```

Detailed guide: `docs/cloudflare-free-deploy.md`

## GitHub App Requirements

- Repository permissions:
  - Pull requests: Read
  - Issues: Read & Write
  - Checks: Read & Write
  - Contents: Read
- Events:
  - Pull request
  - Issue comment
- Webhook URL:
  - `https://<your-host>/webhooks/github`

## Notes

- Cloudflare target is intended as one shared team instance; teammates use the web dashboard instead of each running their own local copy.
- Strict Codex App Server mode on Cloudflare is implemented via workflow dispatch to `.github/workflows/pr-guardian-app-server-runner.yml`.
- Patch suggestions are posted as comment suggestion blocks; no auto-commit is performed.
- v1 repo onboarding limit is enforced via `MAX_REPOS`.
- Cloudflare target keeps infra on free-tier products (Workers, D1, Queues), but model inference still depends on your configured LLM provider/API key.
- Cloudflare queue consumers are at-least-once delivery; handlers are written to explicitly `ack`/`retry` per-message.
