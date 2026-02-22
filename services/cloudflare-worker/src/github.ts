import { createGitHubAppJwt } from './crypto.js';
import { PullRequestFile } from './types.js';

const GITHUB_API = 'https://api.github.com';
const GITHUB_OAUTH = 'https://github.com/login/oauth';

async function githubRequest<T>(token: string, pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'pr-guardian-arena-cloudflare',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${pathname} failed (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
}

async function githubRequestNoContent(token: string, pathname: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'pr-guardian-arena-cloudflare',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${pathname} failed (${response.status}): ${text}`);
  }
}

export async function createInstallationToken(appId: string, privateKeyPem: string, installationId: number): Promise<string> {
  const appToken = await createGitHubAppJwt(appId, privateKeyPem);

  const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${appToken}`,
      'User-Agent': 'pr-guardian-arena-cloudflare',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create installation token (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

export async function exchangeGitHubOAuthCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<string> {
  const response = await fetch(`${GITHUB_OAUTH}/access_token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'pr-guardian-arena-cloudflare'
    },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub OAuth exchange failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? 'GitHub OAuth access token missing');
  }

  return payload.access_token;
}

export async function getGitHubOAuthUser(token: string): Promise<{
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}> {
  const payload = await githubRequest<{ id: number; login: string; name: string | null; avatar_url: string | null }>(token, '/user');
  return {
    id: payload.id,
    login: payload.login,
    name: payload.name,
    avatarUrl: payload.avatar_url
  };
}

export interface UserInstallation {
  id: number;
  appId: number;
  appSlug: string | null;
  accountLogin: string;
}

export interface UserInstallationRepository {
  installationId: number;
  owner: string;
  name: string;
  fullName: string;
}

export async function listUserInstallations(token: string): Promise<UserInstallation[]> {
  const installations: UserInstallation[] = [];

  for (let page = 1; ; page += 1) {
    const data = await githubRequest<{
      installations: Array<{
        id: number;
        app_id: number;
        app_slug: string | null;
        account?: {
          login?: string;
        };
      }>;
    }>(token, `/user/installations?per_page=100&page=${page}`);

    const batch = Array.isArray(data.installations) ? data.installations : [];

    installations.push(
      ...batch.map((installation) => ({
        id: installation.id,
        appId: installation.app_id,
        appSlug: installation.app_slug ?? null,
        accountLogin: installation.account?.login ?? 'unknown'
      }))
    );

    if (batch.length < 100) {
      break;
    }
  }

  return installations;
}

export async function listUserInstallationRepositories(
  token: string,
  installationId: number,
  maxRepos = 200
): Promise<UserInstallationRepository[]> {
  const repositories: UserInstallationRepository[] = [];

  for (let page = 1; repositories.length < maxRepos; page += 1) {
    const data = await githubRequest<{
      repositories: Array<{
        name: string;
        full_name: string;
        owner: {
          login: string;
        };
      }>;
    }>(token, `/user/installations/${installationId}/repositories?per_page=100&page=${page}`);

    const batch = Array.isArray(data.repositories) ? data.repositories : [];

    repositories.push(
      ...batch.slice(0, Math.max(0, maxRepos - repositories.length)).map((repository) => ({
        installationId,
        owner: repository.owner.login,
        name: repository.name,
        fullName: repository.full_name
      }))
    );

    if (batch.length < 100) {
      break;
    }
  }

  return repositories;
}

export async function createCheckRun(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  title: string,
  summary: string,
  text?: string
): Promise<number> {
  const data = await githubRequest<{ id: number }>(token, `/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'PR Guardian Arena',
      head_sha: headSha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      output: {
        title,
        summary: summary.slice(0, 65500),
        text: text?.slice(0, 65500)
      }
    })
  });

  return data.id;
}

export async function updateCheckRun(
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
  conclusion: 'success' | 'failure' | 'cancelled',
  title: string,
  summary: string,
  text?: string
): Promise<void> {
  await githubRequestNoContent(token, `/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title,
        summary: summary.slice(0, 65500),
        text: text?.slice(0, 65500)
      }
    })
  });
}

export async function createIssueComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  await githubRequestNoContent(token, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      body: body.slice(0, 65500)
    })
  });
}

export async function listPullRequestFiles(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  maxFiles = 100
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];

  for (let page = 1; files.length < maxFiles; page += 1) {
    const data = await githubRequest<PullRequestFile[]>(
      token,
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`
    );

    files.push(...data.slice(0, Math.max(0, maxFiles - files.length)));

    if (data.length < 100) {
      break;
    }
  }

  return files;
}
