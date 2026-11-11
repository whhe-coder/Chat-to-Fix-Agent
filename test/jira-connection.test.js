import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiraConnection, JiraApiError, loadJiraToken } from '../src/jira/connection.js';

const cloudId = '00000000-0000-0000-0000-000000000001';

test('Jira token 优先读取环境变量，避免重复访问钥匙串', () => {
  let keychainReads = 0;
  const token = loadJiraToken({
    env: { JIRA_TOKEN: 'env-token' },
    platform: 'darwin',
    execFile: () => { keychainReads += 1; },
  });
  assert.equal(token, 'env-token');
  assert.equal(keychainReads, 0);
});

test('Jira token 可从指定钥匙串项目读取', () => {
  let command;
  let args;
  const token = loadJiraToken({
    env: {},
    platform: 'darwin',
    execFile: (nextCommand, nextArgs) => {
      command = nextCommand;
      args = nextArgs;
      return 'keychain-token\n';
    },
  });
  assert.equal(command, 'security');
  assert.deepEqual(args, [
    'find-generic-password', '-a', 'local-agent',
    '-s', 'Chat-to-Fix-Agent/JIRA_TOKEN', '-w',
  ]);
  assert.equal(token, 'keychain-token');
});

test('用 scoped token 读取指定 board，不返回 token', async () => {
  let requestedUrl;
  let requestedAuthorization;
  const connection = createJiraConnection({
    token: 'test-token',
    cloudId,
    boardId: 42,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestedAuthorization = options.headers.Authorization;
      return new Response(JSON.stringify({
        id: 42,
        name: 'F2PGBA board',
        location: { projectKeyId: 'F2PGBA' },
      }));
    },
  });

  const board = await connection.checkBoard();
  assert.equal(requestedUrl, `https://api.atlassian.com/ex/jira/${cloudId}/rest/agile/1.0/board/42`);
  assert.equal(requestedAuthorization, 'Bearer test-token');
  assert.deepEqual(board, { id: 42, name: 'F2PGBA board', projectKey: 'F2PGBA' });
  assert.ok(!JSON.stringify(board).includes('test-token'));
});

test('个人 scoped token 使用 Basic 身份验证', async () => {
  let authorization;
  const connection = createJiraConnection({
    token: 'test-token',
    email: 'test@example.com',
    cloudId,
    boardId: 42,
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return new Response(JSON.stringify({ id: 42, name: 'F2PGBA board' }));
    },
  });

  await connection.checkBoard();
  assert.equal(authorization, `Basic ${Buffer.from('test@example.com:test-token').toString('base64')}`);
});

test('Jira 失败响应不输出凭据或上游正文', async () => {
  const connection = createJiraConnection({
    token: 'test-token',
    cloudId,
    boardId: 42,
    fetchImpl: async () => new Response('secret test-token', { status: 401 }),
  });

  await assert.rejects(connection.checkBoard(), (error) => {
    assert.ok(error instanceof JiraApiError);
    assert.equal(error.status, 401);
    assert.equal(error.message, 'Jira 返回 401');
    return true;
  });
});
