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

test('创建工单固定到 F2PGBA，并把多行描述转为 ADF', async () => {
  let request;
  const connection = createJiraConnection({
    token: 'test-token', cloudId, boardId: 42,
    fetchImpl: async (url, options) => {
      request = { url, ...options };
      return new Response(JSON.stringify({ id: '901', key: 'F2PGBA-12' }), { status: 201 });
    },
  });

  const result = await connection.createIssue({
    summary: 'Fix checkout', description: 'First line\nSecond line', issueTypeName: 'Bug',
  });
  assert.equal(request.url, `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue`);
  assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(request.body), {
    fields: {
      project: { key: 'F2PGBA' },
      issuetype: { name: 'Bug' },
      summary: 'Fix checkout',
      description: {
        type: 'doc', version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
        ],
      },
    },
  });
  assert.deepEqual(result, { id: '901', key: 'F2PGBA-12' });
  assert.ok(!JSON.stringify(result).includes('test-token'));
});

test('创建工单要求显式 issue type，且不依赖 board ID', async () => {
  let writes = 0;
  const connection = createJiraConnection({
    token: 'test-token', cloudId,
    fetchImpl: async () => {
      writes += 1;
      return new Response(JSON.stringify({ id: '901', key: 'F2PGBA-12' }), { status: 201 });
    },
  });
  await assert.rejects(connection.createIssue({ summary: 'Fix checkout', description: 'Details' }),
    /Issue type 必须/);
  assert.equal(writes, 0);
  assert.deepEqual(await connection.createIssue({
    summary: 'Fix checkout', description: 'Details', issueTypeName: 'Bug',
  }), { id: '901', key: 'F2PGBA-12' });
});

test('新增和更新评论只操作 F2PGBA 工单', async () => {
  const requests = [];
  const connection = createJiraConnection({
    token: 'test-token', cloudId, boardId: 42,
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: '55' }), { status: options.method === 'POST' ? 201 : 200 });
    },
  });

  assert.deepEqual(await connection.addComment({ issue: 'f2pgba-12', body: 'Started' }), {
    issue: 'F2PGBA-12', id: '55',
  });
  assert.deepEqual(await connection.updateComment({ issue: 'F2PGBA-12', id: '55', body: 'Done' }), {
    issue: 'F2PGBA-12', id: '55',
  });
  assert.deepEqual(requests.map(({ url, method }) => [method, url]), [
    ['POST', `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/F2PGBA-12/comment`],
    ['PUT', `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/F2PGBA-12/comment/55`],
  ]);
  assert.deepEqual(requests[0].body.body, {
    type: 'doc', version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Started' }] }],
  });
  await assert.rejects(connection.addComment({ issue: 'OTHER-12', body: 'No' }), /只允许操作 F2PGBA/);
  await assert.rejects(connection.updateComment({ issue: 'F2PGBA-12', id: '../55', body: 'No' }), /Comment ID 无效/);
  assert.equal(requests.length, 2);
});

test('写入失败时不回传 Jira 错误正文', async () => {
  const connection = createJiraConnection({
    token: 'test-token', cloudId, boardId: 42,
    fetchImpl: async () => new Response('secret test-token', { status: 403 }),
  });
  await assert.rejects(connection.createIssue({ summary: 'Test', description: 'Body', issueTypeName: 'Bug' }), (error) => {
    assert.ok(error instanceof JiraApiError);
    assert.equal(error.status, 403);
    assert.equal(error.message, 'Jira 返回 403');
    return true;
  });
});
