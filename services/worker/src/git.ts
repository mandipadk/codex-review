import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface CloneRepoOptions {
  owner: string;
  repo: string;
  headSha: string;
  baseBranch: string;
  token: string;
  targetDir: string;
}

async function runGit(args: string[], cwd?: string): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0'
    }
  });
}

export async function cloneRepoAtSha(options: CloneRepoOptions): Promise<void> {
  await mkdir(dirname(options.targetDir), { recursive: true });
  await rm(options.targetDir, { recursive: true, force: true });
  await mkdir(options.targetDir, { recursive: true });

  const encodedToken = encodeURIComponent(options.token);
  const remoteUrl = `https://x-access-token:${encodedToken}@github.com/${options.owner}/${options.repo}.git`;

  await runGit(['init'], options.targetDir);
  await runGit(['remote', 'add', 'origin', remoteUrl], options.targetDir);
  await runGit(['fetch', '--depth=1', 'origin', options.baseBranch], options.targetDir);
  await runGit(['fetch', '--depth=1', 'origin', options.headSha], options.targetDir);
  await runGit(['checkout', '--detach', options.headSha], options.targetDir);
}

export async function removeRepoClone(pathToRepo: string): Promise<void> {
  await rm(pathToRepo, { recursive: true, force: true });
}
