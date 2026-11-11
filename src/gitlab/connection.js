import { execFileSync } from 'node:child_process';
import { createGitlabClient } from './client.js';

export function loadGitlabToken({
  env = process.env,
  platform = process.platform,
  execFile = execFileSync,
} = {}) {
  if (env.GITLAB_TOKEN) return env.GITLAB_TOKEN;
  if (platform !== 'darwin') return undefined;
  try {
    return execFile('security', [
      'find-generic-password',
      '-a', 'local-agent',
      '-s', 'Chat-to-Fix-Agent/GITLAB_TOKEN',
      '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function createGitlabConnection({
  token = loadGitlabToken(),
  gitlabUrl = process.env.GITLAB_URL || 'https://gitlab.loc',
  project = process.env.GITLAB_PROJECT || 'account-platform/free-to-play-pc',
  fetchImpl = fetch,
} = {}) {
  const client = createGitlabClient({ token, gitlabUrl, project, fetchImpl });

  return {
    configured: Boolean(token),
    async checkConnection(branch = 'master') {
      const data = await client.getBranch(branch);
      if (typeof data?.name !== 'string' || typeof data?.commit?.id !== 'string') {
        throw new Error('GitLab 分支响应无效');
      }
      return { project, branch: data.name, commit: data.commit.id };
    },
    ...client,
  };
}
