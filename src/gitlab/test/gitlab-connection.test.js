import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitlabConnection, loadGitlabToken } from '../connection.js';

test('环境变量 token 优先，读取时不调用 Mac 钥匙串', () => {
  const token = loadGitlabToken({
    env: { GITLAB_TOKEN: 'env-token' },
    platform: 'darwin',
    execFile: () => { throw new Error('不应读取钥匙串'); },
  });
  assert.equal(token, 'env-token');
});

test('从 Mac 钥匙串取得 token 后可独立检查目标分支，不返回 token', async () => {
  let keychainReads = 0;
  let requestedToken;
  const token = loadGitlabToken({
    env: {},
    platform: 'darwin',
    execFile: (command, args) => {
      keychainReads += 1;
      assert.equal(command, 'security');
      assert.deepEqual(args, [
        'find-generic-password', '-a', 'local-agent',
        '-s', 'Chat-to-Fix-Agent/GITLAB_TOKEN', '-w',
      ]);
      return 'keychain-token\n';
    },
  });
  const connection = createGitlabConnection({
    token,
    fetchImpl: async (_url, options) => {
      requestedToken = options.headers['PRIVATE-TOKEN'];
      return new Response(JSON.stringify({ name: 'master', commit: { id: 'abc123' } }));
    },
  });

  assert.equal(connection.configured, true);
  assert.deepEqual(await connection.checkConnection(), {
    project: 'account-platform/free-to-play-pc',
    branch: 'master',
    commit: 'abc123',
  });
  assert.equal(keychainReads, 1);
  assert.equal(requestedToken, token);
  assert.ok(!JSON.stringify(connection).includes(token));
});
