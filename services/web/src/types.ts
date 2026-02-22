export interface GitHubRepositoryPayload {
  name: string;
  owner: {
    login: string;
  };
}

export interface PullRequestPayload {
  action: string;
  installation?: { id: number };
  repository: GitHubRepositoryPayload;
  label?: { name?: string };
  pull_request: {
    number: number;
    head: {
      sha: string;
      ref: string;
    };
    base: {
      ref: string;
    };
  };
}

export interface IssueCommentPayload {
  action: string;
  installation?: { id: number };
  repository: GitHubRepositoryPayload;
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
