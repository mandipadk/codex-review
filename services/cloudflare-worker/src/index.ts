import { parseChatOpsCommand } from './chatops.js';
import { applyConfigOverrides, readConfig, repoKey } from './config.js';
import { randomToken, sha256Hex, verifyGitHubSignature } from './crypto.js';
import {
  exchangeGitHubOAuthCode,
  getGitHubOAuthUser,
  listUserInstallationRepositories,
  listUserInstallations
} from './github.js';
import { enqueueJob, enqueueRun, handleQueueJob } from './orchestrator.js';
import { D1Store } from './store.js';
import { AppConfig, DashboardUser, Env, QueueJob, RepoRecord } from './types.js';

const SESSION_COOKIE = 'pga_session';
const OAUTH_STATE_COOKIE = 'pga_oauth_state';
const MAX_TOP_PATCH_COUNT = 10;

interface PullRequestWebhook {
  action: string;
  installation?: { id: number };
  label?: { name?: string };
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  pull_request: {
    number: number;
    head: {
      sha: string;
    };
    base: {
      ref: string;
    };
  };
}

interface IssueCommentWebhook {
  action: string;
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  issue: {
    number: number;
    pull_request?: {
      url: string;
    };
  };
  comment: {
    body: string;
  };
}

interface DashboardRepoOption {
  owner: string;
  name: string;
  fullName: string;
  installationId: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

function html(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8'
    }
  });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    location
  });

  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }

  return new Response(null, {
    status: 302,
    headers
  });
}

function shouldTriggerPullRequest(action: string, label?: string): boolean {
  if (action === 'opened' || action === 'synchronize' || action === 'reopened') {
    return true;
  }

  if (action === 'labeled' && label === 'codex-review') {
    return true;
  }

  return false;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function cookieIsSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    maxAge?: number;
    secure: boolean;
    httpOnly?: boolean;
  }
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];

  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }

  if (options.secure) {
    parts.push('Secure');
  }

  if (typeof options.maxAge === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }

  return parts.join('; ');
}

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  const entries = cookieHeader.split(';');
  for (const entry of entries) {
    const index = entry.indexOf('=');
    if (index <= 0) {
      continue;
    }

    const key = entry.slice(0, index).trim();
    if (key !== name) {
      continue;
    }

    return decodeURIComponent(entry.slice(index + 1).trim());
  }

  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseAllowlist(value: string): string[] {
  const set = new Set(
    value
      .split(/[\n,]/g)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );

  return Array.from(set).sort();
}

function parseRepoSelection(raw: string): DashboardRepoOption | null {
  const parts = raw.split('|');
  if (parts.length !== 3) {
    return null;
  }

  const [installationIdText, ownerRaw, nameRaw] = parts;
  const installationId = Number(installationIdText);
  const owner = ownerRaw?.trim();
  const name = nameRaw?.trim();

  if (!Number.isInteger(installationId) || installationId <= 0) {
    return null;
  }

  if (!owner || !name) {
    return null;
  }

  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    installationId
  };
}

function normalizeAppBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function loadEffectiveConfig(env: Env, store: D1Store): Promise<AppConfig> {
  return applyConfigOverrides(readConfig(env), await store.getConfigOverrides());
}

async function loadSessionUser(request: Request, store: D1Store): Promise<DashboardUser | null> {
  const sessionToken = getCookie(request, SESSION_COOKIE);
  if (!sessionToken) {
    return null;
  }

  const hash = await sha256Hex(sessionToken);
  return store.getDashboardUserBySessionTokenHash(hash);
}

async function requireSessionUser(request: Request, store: D1Store): Promise<DashboardUser | Response> {
  const user = await loadSessionUser(request, store);
  if (!user) {
    return redirect('/auth/github/start');
  }

  return user;
}

async function loadAvailableRepos(env: Env, userToken: string): Promise<DashboardRepoOption[]> {
  const targetSlug = env.GITHUB_APP_SLUG?.trim().toLowerCase() ?? null;
  const targetAppId = Number.parseInt(env.GITHUB_APP_ID, 10);

  const installations = await listUserInstallations(userToken);
  const filteredInstallations = installations.filter((installation) => {
    if (targetSlug) {
      return (installation.appSlug ?? '').toLowerCase() === targetSlug;
    }

    if (Number.isInteger(targetAppId) && targetAppId > 0) {
      return installation.appId === targetAppId;
    }

    return true;
  });

  const batches = await Promise.all(
    filteredInstallations.map((installation) => listUserInstallationRepositories(userToken, installation.id, 300))
  );

  const seen = new Set<string>();
  const repos: DashboardRepoOption[] = [];

  for (const batch of batches) {
    for (const repo of batch) {
      const key = repoKey(repo.owner, repo.name);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      repos.push({
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        installationId: repo.installationId
      });
    }
  }

  repos.sort((left, right) => left.fullName.localeCompare(right.fullName));
  return repos;
}

function renderLandingPage(baseUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PR Guardian Arena</title>
    <style>
      :root {
        --bg: #f5f7fa;
        --card: #ffffff;
        --ink: #0f172a;
        --subtle: #475569;
        --primary: #0f766e;
        --ring: #99f6e4;
        --border: #dbe3ec;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at 20% 20%, #e6fffa 0%, #f5f7fa 45%, #eef2ff 100%);
        color: var(--ink);
        font-family: "Söhne", "Avenir Next", "Segoe UI", sans-serif;
      }
      .card {
        width: min(920px, calc(100vw - 2rem));
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 2.25rem;
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
      }
      h1 {
        margin: 0 0 0.6rem 0;
        font-size: clamp(1.8rem, 4vw, 2.6rem);
      }
      p { color: var(--subtle); line-height: 1.45; }
      .cta {
        display: inline-flex;
        align-items: center;
        margin-top: 1.2rem;
        border-radius: 10px;
        text-decoration: none;
        background: var(--primary);
        color: #ffffff;
        font-weight: 700;
        padding: 0.8rem 1.2rem;
      }
      .meta {
        margin-top: 1.4rem;
        color: var(--subtle);
        font-size: 0.92rem;
      }
      code {
        background: #f1f5f9;
        padding: 0.1rem 0.28rem;
        border-radius: 4px;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>PR Guardian Arena</h1>
      <p>Shared GitHub PR copilot for your team. Sign in with GitHub, choose installed repositories, and control review behavior from one hosted dashboard.</p>
      <a class="cta" href="/auth/github/start">Login with GitHub</a>
      <div class="meta">
        Worker base URL: <code>${escapeHtml(baseUrl)}</code><br />
        Webhook endpoint: <code>${escapeHtml(baseUrl)}/webhooks/github</code>
      </div>
    </main>
  </body>
</html>`;
}

function renderDashboardPage(params: {
  baseUrl: string;
  user: DashboardUser;
  config: AppConfig;
  availableRepos: DashboardRepoOption[];
  managedRepos: RepoRecord[];
  statusMessage: string | null;
  repoLoadError: string | null;
}): string {
  const activeSet = new Set(
    params.managedRepos.filter((repo) => repo.active).map((repo) => repoKey(repo.owner, repo.name))
  );

  const availableMarkup =
    params.availableRepos.length === 0
      ? '<p class="note">No repositories visible yet for this GitHub App installation.</p>'
      : `<div class="repo-grid">${params.availableRepos
          .map((repo) => {
            const key = repoKey(repo.owner, repo.name);
            const checked = activeSet.has(key) ? 'checked' : '';
            const value = `${repo.installationId}|${repo.owner}|${repo.name}`;

            return `<label class="repo-card">
              <input type="checkbox" name="repo" value="${escapeHtml(value)}" ${checked} />
              <span class="repo-title">${escapeHtml(repo.fullName)}</span>
              <span class="repo-meta">installation ${repo.installationId}</span>
            </label>`;
          })
          .join('')}</div>`;

  const managedMarkup =
    params.managedRepos.length === 0
      ? '<p class="note">No repositories are managed yet.</p>'
      : `<ul class="managed-list">${params.managedRepos
          .map(
            (repo) =>
              `<li><strong>${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</strong> <span class="${
                repo.active ? 'pill active' : 'pill inactive'
              }">${repo.active ? 'active' : 'inactive'}</span></li>`
          )
          .join('')}</ul>`;

  const statusBanner = params.statusMessage ? `<div class="banner">${escapeHtml(params.statusMessage)}</div>` : '';
  const repoLoadError = params.repoLoadError ? `<div class="warn">${escapeHtml(params.repoLoadError)}</div>` : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PR Guardian Arena Dashboard</title>
    <style>
      :root {
        --bg: #f3f6f8;
        --card: #ffffff;
        --ink: #0f172a;
        --subtle: #475569;
        --accent: #0f766e;
        --danger: #b91c1c;
        --border: #d9e2ec;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: linear-gradient(180deg, #e6fffa 0%, #f8fafc 46%, #eef2ff 100%);
        color: var(--ink);
        font-family: "Söhne", "Avenir Next", "Segoe UI", sans-serif;
      }
      .wrap {
        width: min(1080px, calc(100vw - 2rem));
        margin: 1.25rem auto 2.2rem;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1rem;
      }
      h1 { margin: 0; font-size: 1.5rem; }
      .muted { color: var(--subtle); }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 1rem 1rem 1.1rem;
        box-shadow: 0 12px 34px rgba(15, 23, 42, 0.08);
        margin-bottom: 0.95rem;
      }
      .grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: 1fr;
      }
      @media (min-width: 920px) {
        .grid { grid-template-columns: 1fr 1fr; }
      }
      label {
        display: block;
        font-size: 0.92rem;
        font-weight: 600;
        margin: 0.6rem 0 0.25rem;
      }
      input[type="text"], input[type="number"], textarea {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 9px;
        padding: 0.6rem 0.65rem;
        font: inherit;
      }
      textarea { min-height: 88px; resize: vertical; }
      button {
        border: 0;
        border-radius: 9px;
        background: var(--accent);
        color: #ffffff;
        font: inherit;
        font-weight: 700;
        padding: 0.62rem 0.95rem;
        cursor: pointer;
      }
      .btn-light {
        background: #1e293b;
      }
      .repo-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 0.7rem;
      }
      .repo-card {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.45rem 0.55rem;
        align-items: center;
        border: 1px solid #d5deea;
        border-radius: 10px;
        padding: 0.7rem;
      }
      .repo-title { font-weight: 700; }
      .repo-meta {
        color: var(--subtle);
        font-size: 0.82rem;
        grid-column: 2;
      }
      .managed-list {
        margin: 0;
        padding: 0 0 0 1.1rem;
      }
      .managed-list li {
        margin: 0.35rem 0;
      }
      .pill {
        border-radius: 999px;
        padding: 0.12rem 0.5rem;
        font-size: 0.75rem;
        vertical-align: middle;
      }
      .pill.active {
        background: #dcfce7;
        color: #166534;
      }
      .pill.inactive {
        background: #f1f5f9;
        color: #334155;
      }
      .banner {
        background: #ecfeff;
        border: 1px solid #99f6e4;
        color: #155e75;
        border-radius: 8px;
        padding: 0.62rem 0.72rem;
        margin-bottom: 0.95rem;
      }
      .warn {
        background: #fef2f2;
        border: 1px solid #fecaca;
        color: var(--danger);
        border-radius: 8px;
        padding: 0.62rem 0.72rem;
        margin-bottom: 0.8rem;
      }
      .note {
        margin: 0.15rem 0 0;
        color: var(--subtle);
      }
      .inline {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <div>
          <h1>PR Guardian Arena Dashboard</h1>
          <div class="muted">Signed in as <strong>${escapeHtml(params.user.login)}</strong> (${escapeHtml(params.user.name ?? 'no public name')})</div>
        </div>
        <form action="/logout" method="post">
          <button class="btn-light" type="submit">Logout</button>
        </form>
      </header>
      ${statusBanner}
      <div class="card">
        <div><strong>Webhook endpoint</strong>: <code>${escapeHtml(params.baseUrl)}/webhooks/github</code></div>
        <div class="muted" style="margin-top: 0.28rem;">Managed repos limit: ${params.config.maxRepos}</div>
      </div>
      <div class="grid">
        <section class="card">
          <h2>Runtime Settings</h2>
          <form action="/app/settings" method="post">
            <label for="model">Model</label>
            <input id="model" name="model" type="text" value="${escapeHtml(params.config.model)}" />

            <label for="topPatchCount">Patch suggestions per run</label>
            <input id="topPatchCount" name="topPatchCount" type="number" min="1" max="${MAX_TOP_PATCH_COUNT}" value="${
              params.config.topPatchCount
            }" />

            <label for="allowlist">Repo allowlist (comma/newline, optional)</label>
            <textarea id="allowlist" name="allowlist">${escapeHtml(Array.from(params.config.allowlist).join(', '))}</textarea>

            <label class="inline">
              <input name="autoOnboardWebhooks" type="checkbox" ${params.config.autoOnboardWebhooks ? 'checked' : ''} />
              Auto-onboard repos when webhook arrives
            </label>

            <div style="margin-top: 0.8rem;">
              <button type="submit">Save Settings</button>
            </div>
          </form>
        </section>
        <section class="card">
          <h2>Managed Repositories</h2>
          ${managedMarkup}
        </section>
      </div>
      <section class="card">
        <h2>Select Repositories</h2>
        ${repoLoadError}
        <form action="/app/repos/sync" method="post">
          ${availableMarkup}
          <div style="margin-top: 0.9rem;">
            <button type="submit">Apply Repository Selection</button>
          </div>
        </form>
      </section>
    </div>
  </body>
</html>`;
}

async function handleLanding(request: Request, env: Env): Promise<Response> {
  const store = new D1Store(env.DB);
  const user = await loadSessionUser(request, store);
  if (user) {
    return redirect('/app');
  }

  return html(renderLandingPage(normalizeAppBaseUrl(env.APP_BASE_URL)));
}

async function handleAuthStart(request: Request, env: Env): Promise<Response> {
  const baseUrl = normalizeAppBaseUrl(env.APP_BASE_URL);
  const state = randomToken(24);
  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', env.GITHUB_OAUTH_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', `${baseUrl}/auth/github/callback`);
  authorizeUrl.searchParams.set('scope', 'read:user read:org');
  authorizeUrl.searchParams.set('state', state);

  return redirect(authorizeUrl.toString(), [
    serializeCookie(OAUTH_STATE_COOKIE, state, {
      secure: cookieIsSecure(request),
      httpOnly: true,
      maxAge: 10 * 60
    })
  ]);
}

async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = getCookie(request, OAUTH_STATE_COOKIE);

  if (!code || !state || !cookieState || state !== cookieState) {
    return html('<h1>OAuth state mismatch</h1><p>Retry login from the home page.</p>', 400);
  }

  const store = new D1Store(env.DB);
  const accessToken = await exchangeGitHubOAuthCode({
    clientId: env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    code
  });

  const profile = await getGitHubOAuthUser(accessToken);
  const user = await store.upsertDashboardUser({
    githubUserId: profile.id,
    login: profile.login,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    accessToken
  });

  const sessionTtlDays = parsePositiveInt(env.SESSION_TTL_DAYS, 14);
  const sessionMaxAge = sessionTtlDays * 24 * 60 * 60;
  const expiresAt = Math.floor(Date.now() / 1000) + sessionMaxAge;
  const sessionToken = randomToken(32);
  const sessionHash = await sha256Hex(sessionToken);

  await store.pruneExpiredSessions();
  await store.createSession(user.id, sessionHash, expiresAt);

  return redirect('/app', [
    serializeCookie(SESSION_COOKIE, sessionToken, {
      secure: cookieIsSecure(request),
      httpOnly: true,
      maxAge: sessionMaxAge
    }),
    serializeCookie(OAUTH_STATE_COOKIE, '', {
      secure: cookieIsSecure(request),
      httpOnly: true,
      maxAge: 0
    })
  ]);
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const store = new D1Store(env.DB);
  const sessionToken = getCookie(request, SESSION_COOKIE);
  if (sessionToken) {
    const sessionHash = await sha256Hex(sessionToken);
    await store.deleteSessionByTokenHash(sessionHash);
  }

  return redirect('/', [
    serializeCookie(SESSION_COOKIE, '', {
      secure: cookieIsSecure(request),
      httpOnly: true,
      maxAge: 0
    })
  ]);
}

async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const store = new D1Store(env.DB);
  const sessionUser = await requireSessionUser(request, store);
  if (sessionUser instanceof Response) {
    return sessionUser;
  }

  const config = await loadEffectiveConfig(env, store);
  const managedRepos = await store.listRepos();

  let repoLoadError: string | null = null;
  let availableRepos: DashboardRepoOption[] = [];

  try {
    availableRepos = await loadAvailableRepos(env, sessionUser.accessToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    repoLoadError = `Unable to load installation repos from GitHub: ${message}`;
  }

  const status = new URL(request.url).searchParams.get('status');
  const statusMessage =
    status === 'settings_saved'
      ? 'Settings saved.'
      : status === 'repos_saved'
        ? 'Repository selection applied.'
        : status === 'too_many_repos'
          ? `Selected repositories exceed max limit (${config.maxRepos}).`
          : null;

  return html(
    renderDashboardPage({
      baseUrl: normalizeAppBaseUrl(env.APP_BASE_URL),
      user: sessionUser,
      config,
      availableRepos,
      managedRepos,
      statusMessage,
      repoLoadError
    })
  );
}

async function handleSettingsUpdate(request: Request, env: Env): Promise<Response> {
  const store = new D1Store(env.DB);
  const sessionUser = await requireSessionUser(request, store);
  if (sessionUser instanceof Response) {
    return sessionUser;
  }

  const currentConfig = await loadEffectiveConfig(env, store);
  const form = await request.formData();

  const model = String(form.get('model') ?? '').trim();
  const requestedTopPatchCount = Number(form.get('topPatchCount'));
  const topPatchCount =
    Number.isInteger(requestedTopPatchCount) && requestedTopPatchCount > 0
      ? Math.min(requestedTopPatchCount, MAX_TOP_PATCH_COUNT)
      : currentConfig.topPatchCount;
  const allowlist = parseAllowlist(String(form.get('allowlist') ?? ''));
  const autoOnboardWebhooks = form.get('autoOnboardWebhooks') === 'on';

  await store.setAppSetting('model', model || null);
  await store.setAppSetting('topPatchCount', topPatchCount);
  await store.setAppSetting('allowlist', allowlist);
  await store.setAppSetting('autoOnboardWebhooks', autoOnboardWebhooks);

  return redirect('/app?status=settings_saved');
}

async function handleRepoSync(request: Request, env: Env): Promise<Response> {
  const store = new D1Store(env.DB);
  const sessionUser = await requireSessionUser(request, store);
  if (sessionUser instanceof Response) {
    return sessionUser;
  }

  const config = await loadEffectiveConfig(env, store);
  const availableRepos = await loadAvailableRepos(env, sessionUser.accessToken);
  const allowedSelections = new Map<string, DashboardRepoOption>();
  for (const repo of availableRepos) {
    allowedSelections.set(`${repo.installationId}|${repoKey(repo.owner, repo.name)}`, repo);
  }

  const form = await request.formData();
  const selected = new Map<string, DashboardRepoOption>();

  for (const value of form.getAll('repo')) {
    if (typeof value !== 'string') {
      continue;
    }
    const parsed = parseRepoSelection(value);
    if (!parsed) {
      continue;
    }
    const normalizedKey = repoKey(parsed.owner, parsed.name);
    const allowed = allowedSelections.get(`${parsed.installationId}|${normalizedKey}`);
    if (!allowed) {
      continue;
    }
    selected.set(normalizedKey, allowed);
  }

  if (selected.size > config.maxRepos) {
    return redirect('/app?status=too_many_repos');
  }

  for (const repo of selected.values()) {
    await store.upsertRepo({
      owner: repo.owner,
      name: repo.name,
      installationId: repo.installationId,
      active: true
    });
  }

  const existingRepos = await store.listRepos();
  for (const repo of existingRepos) {
    const key = repoKey(repo.owner, repo.name);
    if (!selected.has(key) && repo.active) {
      await store.setRepoActive(repo.id, false);
    }
  }

  return redirect('/app?status=repos_saved');
}

async function handlePullRequestWebhook(env: Env, payload: PullRequestWebhook): Promise<Response> {
  const store = new D1Store(env.DB);
  const config = await loadEffectiveConfig(env, store);

  if (!shouldTriggerPullRequest(payload.action, payload.label?.name)) {
    return json({ ignored: true, reason: 'action not eligible' }, 202);
  }

  const owner = payload.repository.owner.login;
  const name = payload.repository.name;

  if (config.allowlist.size > 0 && !config.allowlist.has(repoKey(owner, name))) {
    return json({ ignored: true, reason: 'repo not in allowlist' }, 202);
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    return json({ ignored: true, reason: 'missing installation id' }, 202);
  }

  const existingRepo = await store.getRepoByOwnerAndName(owner, name);
  if (!existingRepo && !config.autoOnboardWebhooks) {
    return json({ ignored: true, reason: 'repo not onboarded; use dashboard' }, 202);
  }

  if (existingRepo && !existingRepo.active && !config.autoOnboardWebhooks) {
    return json({ ignored: true, reason: 'repo inactive; enable it from dashboard' }, 202);
  }

  if (!existingRepo) {
    const count = await store.countActiveRepos();
    if (count >= config.maxRepos) {
      return json(
        {
          ignored: true,
          reason: `repo limit reached (${config.maxRepos})`
        },
        409
      );
    }
  }

  const repo = await store.upsertRepo({ owner, name, installationId, active: true });

  await store.cancelStaleRuns(repo.id, payload.pull_request.number, payload.pull_request.head.sha);

  const run = await store.createRun({
    repoId: repo.id,
    prNumber: payload.pull_request.number,
    headSha: payload.pull_request.head.sha,
    baseBranch: payload.pull_request.base.ref,
    trigger: `webhook:${payload.action}`
  });

  await enqueueRun(env, run.id);

  return json({ accepted: true, runId: run.id }, 202);
}

async function handleIssueCommentWebhook(env: Env, payload: IssueCommentWebhook): Promise<Response> {
  const store = new D1Store(env.DB);

  if (payload.action !== 'created' || !payload.issue.pull_request) {
    return json({ ignored: true, reason: 'not a pull request comment' }, 202);
  }

  const command = parseChatOpsCommand(payload.comment.body);
  if (!command) {
    return json({ ignored: true, reason: 'no codex command' }, 202);
  }

  const owner = payload.repository.owner.login;
  const name = payload.repository.name;
  const prNumber = payload.issue.number;

  const latestRun = await store.getLatestRunWithRepoByPr(owner, name, prNumber);
  if (!latestRun) {
    return json({ ignored: true, reason: 'no prior run available' }, 202);
  }

  if (command.type === 'rerun') {
    const run = await store.createRun({
      repoId: latestRun.repoId,
      prNumber: latestRun.prNumber,
      headSha: latestRun.headSha,
      baseBranch: latestRun.baseBranch,
      trigger: `chatops:rerun:${command.scope ?? 'all'}`
    });

    await enqueueRun(env, run.id);
    return json({ accepted: true, command: command.type, runId: run.id }, 202);
  }

  if (command.type === 'explain' && command.findingId) {
    await enqueueJob(env, {
      type: 'explain_finding',
      runId: latestRun.id,
      findingId: command.findingId
    });

    return json({ accepted: true, command: command.type }, 202);
  }

  if (command.type === 'patch' && command.findingId) {
    await enqueueJob(env, {
      type: 'patch_finding',
      runId: latestRun.id,
      findingId: command.findingId
    });

    return json({ accepted: true, command: command.type }, 202);
  }

  const running = await store.findRunningRun(latestRun.repoId, latestRun.prNumber);
  if (!running) {
    return json({ ignored: true, reason: 'no running run to stop' }, 202);
  }

  await store.requestCancel(running.id, 'User requested stop via /codex stop');
  await enqueueJob(env, {
    type: 'cancel_run',
    runId: running.id,
    reason: 'User requested stop via /codex stop'
  });

  return json({ accepted: true, command: command.type, runId: running.id }, 202);
}

async function handleInternalRetry(env: Env, runId: number): Promise<Response> {
  const store = new D1Store(env.DB);
  const run = await store.getRunWithRepo(runId);

  if (!run) {
    return json({ error: 'run not found' }, 404);
  }

  const created = await store.createRun({
    repoId: run.repoId,
    prNumber: run.prNumber,
    headSha: run.headSha,
    baseBranch: run.baseBranch,
    trigger: 'internal_retry'
  });

  await enqueueRun(env, created.id);
  return json({ accepted: true, runId: created.id }, 202);
}

async function handleInternalCancel(env: Env, runId: number): Promise<Response> {
  const store = new D1Store(env.DB);
  await store.requestCancel(runId, 'Internal cancel endpoint');

  await enqueueJob(env, {
    type: 'cancel_run',
    runId,
    reason: 'Internal cancel endpoint'
  });

  return json({ accepted: true, runId }, 202);
}

async function handleWebhookRequest(request: Request, env: Env): Promise<Response> {
  const event = request.headers.get('x-github-event');
  if (!event) {
    return json({ error: 'missing x-github-event' }, 400);
  }

  const rawBody = await request.text();

  const signature = request.headers.get('x-hub-signature-256');
  const verified = await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature);
  if (!verified) {
    return json({ error: 'invalid signature' }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid json payload' }, 400);
  }

  if (event === 'pull_request') {
    return handlePullRequestWebhook(env, payload as PullRequestWebhook);
  }

  if (event === 'issue_comment') {
    return handleIssueCommentWebhook(env, payload as IssueCommentWebhook);
  }

  return json({ ignored: true, event }, 202);
}

const worker: ExportedHandler<Env, QueueJob> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok' });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return handleLanding(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/auth/github/start') {
      return handleAuthStart(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/auth/github/callback') {
      return handleAuthCallback(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/logout') {
      return handleLogout(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/app') {
      return handleDashboard(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/app/settings') {
      return handleSettingsUpdate(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/app/repos/sync') {
      return handleRepoSync(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/github') {
      return handleWebhookRequest(request, env);
    }

    const retryMatch = /^\/internal\/runs\/(\d+)\/retry$/.exec(url.pathname);
    if (request.method === 'POST' && retryMatch) {
      const runId = Number(retryMatch[1]);
      return handleInternalRetry(env, runId);
    }

    const cancelMatch = /^\/internal\/runs\/(\d+)\/cancel$/.exec(url.pathname);
    if (request.method === 'POST' && cancelMatch) {
      const runId = Number(cancelMatch[1]);
      return handleInternalCancel(env, runId);
    }

    return json({ error: 'not found' }, 404);
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const job = message.body;

        if (!job || typeof job !== 'object' || typeof (job as { type?: unknown }).type !== 'string') {
          message.ack();
          continue;
        }

        await handleQueueJob(env, job as QueueJob);
        message.ack();
      } catch (error) {
        const retryDelay = Math.min(3600, 30 * 2 ** message.attempts);
        console.error('Queue job failed', {
          id: message.id,
          attempts: message.attempts,
          error: error instanceof Error ? error.message : String(error)
        });

        if (message.attempts >= 3) {
          message.ack();
        } else {
          message.retry({ delaySeconds: retryDelay });
        }
      }
    }
  }
};

export default worker;
