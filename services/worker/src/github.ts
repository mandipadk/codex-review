import { GitHubAppClientFactory } from '@pr-guardian/common';

export interface GitHubContext {
  owner: string;
  repo: string;
  installationId: number;
}

export interface GitHubCheckRunResult {
  id: number;
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
}

export interface GitHubService {
  createCheckRun(context: GitHubContext, headSha: string, output: CheckRunOutput): Promise<GitHubCheckRunResult | null>;
  updateCheckRun(
    context: GitHubContext,
    checkRunId: number,
    conclusion: 'success' | 'failure' | 'cancelled',
    output: CheckRunOutput
  ): Promise<void>;
  createIssueComment(context: GitHubContext, issueNumber: number, body: string): Promise<void>;
  getInstallationToken(installationId: number): Promise<string>;
}

export class GitHubServiceImpl implements GitHubService {
  constructor(private readonly factory: GitHubAppClientFactory) {}

  async createCheckRun(context: GitHubContext, headSha: string, output: CheckRunOutput): Promise<GitHubCheckRunResult> {
    const octokit = await this.getClient(context.installationId);

    const created = await octokit.checks.create({
      owner: context.owner,
      repo: context.repo,
      name: 'PR Guardian Arena',
      head_sha: headSha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      output: {
        title: output.title,
        summary: output.summary.slice(0, 65_000),
        text: output.text?.slice(0, 65_000)
      }
    });

    return {
      id: created.data.id
    };
  }

  async updateCheckRun(
    context: GitHubContext,
    checkRunId: number,
    conclusion: 'success' | 'failure' | 'cancelled',
    output: CheckRunOutput
  ): Promise<void> {
    const octokit = await this.getClient(context.installationId);

    await octokit.checks.update({
      owner: context.owner,
      repo: context.repo,
      check_run_id: checkRunId,
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: output.title,
        summary: output.summary.slice(0, 65_000),
        text: output.text?.slice(0, 65_000)
      }
    });
  }

  async createIssueComment(context: GitHubContext, issueNumber: number, body: string): Promise<void> {
    const octokit = await this.getClient(context.installationId);

    await octokit.issues.createComment({
      owner: context.owner,
      repo: context.repo,
      issue_number: issueNumber,
      body: body.slice(0, 65_000)
    });
  }

  async getInstallationToken(installationId: number): Promise<string> {
    return this.factory.getInstallationToken(installationId);
  }

  private getClient(installationId: number): Promise<any> {
    return this.factory.getInstallationClient(installationId);
  }
}
