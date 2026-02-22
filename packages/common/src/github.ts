import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
}

export class GitHubAppClientFactory {
  private readonly appId: number;
  private readonly privateKey: string;

  constructor(config: GitHubAppConfig) {
    this.appId = Number(config.appId);
    this.privateKey = config.privateKey;

    if (Number.isNaN(this.appId)) {
      throw new Error('GITHUB_APP_ID must be numeric');
    }
  }

  async getInstallationClient(installationId: number): Promise<Octokit> {
    const token = await this.getInstallationToken(installationId);

    return new Octokit({ auth: token });
  }

  async getInstallationToken(installationId: number): Promise<string> {
    const auth = createAppAuth({
      appId: this.appId,
      privateKey: this.privateKey
    });

    const token = await auth({
      type: 'installation',
      installationId
    });

    return token.token;
  }
}
