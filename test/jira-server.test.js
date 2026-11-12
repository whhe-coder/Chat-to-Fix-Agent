import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiraConnection } from '../src/jira/connection.js';
import { createLocalServer } from '../src/server/local-server.js';

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonRequest(method, body, headers = {}) {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

test('本地服务提供 board 检查、创建工单、添加和更新评论', async () => {
  const calls = [];
  const jiraConnection = {
    configured: true,
    checkBoard: async () => ({ id: 42, name: 'F2PGBA board', projectKey: null }),
    createIssue: async (data) => {
      calls.push(['create', data]);
      return { id: '901', key: 'F2PGBA-12' };
    },
    addComment: async (data) => {
      calls.push(['add', data]);
      return { issue: data.issue, id: '55' };
    },
    updateComment: async (data) => {
      calls.push(['update', data]);
      return { issue: data.issue, id: data.id };
    },
  };

  await withServer(createLocalServer({ jiraConnection }), async (base) => {
    const board = await fetch(`${base}/jira/board`);
    assert.equal(board.status, 200);
    assert.deepEqual(await board.json(), { ok: true, id: 42, name: 'F2PGBA board', projectKey: null });

    const created = await fetch(`${base}/jira/issues`, jsonRequest('POST', {
      summary: 'Fix checkout', description: 'Details', issueTypeName: 'Bug',
    }));
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { ok: true, id: '901', key: 'F2PGBA-12' });

    const added = await fetch(`${base}/jira/issues/F2PGBA-12/comments`, jsonRequest('POST', { body: 'Started' }));
    assert.equal(added.status, 201);
    assert.deepEqual(await added.json(), { ok: true, issue: 'F2PGBA-12', id: '55' });

    const updated = await fetch(`${base}/jira/issues/F2PGBA-12/comments/55`, jsonRequest('PUT', { body: 'Done' }));
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), { ok: true, issue: 'F2PGBA-12', id: '55' });
  });
  assert.deepEqual(calls, [
    ['create', { summary: 'Fix checkout', description: 'Details', issueTypeName: 'Bug' }],
    ['add', { issue: 'F2PGBA-12', body: 'Started' }],
    ['update', { issue: 'F2PGBA-12', id: '55', body: 'Done' }],
  ]);
});

test('写入接口拒绝跨站、非 JSON 和跨项目路径', async () => {
  let writes = 0;
  const jiraConnection = {
    configured: true,
    createIssue: async () => { writes += 1; },
    addComment: async () => { writes += 1; },
  };
  await withServer(createLocalServer({ jiraConnection }), async (base) => {
    const crossSite = await fetch(`${base}/jira/issues`, jsonRequest('POST', {
      summary: 'No', description: 'No',
    }, { Origin: 'https://example.com' }));
    assert.equal(crossSite.status, 403);

    const plainText = await fetch(`${base}/jira/issues`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
    });
    assert.equal(plainText.status, 415);

    const otherProject = await fetch(`${base}/jira/issues/OTHER-12/comments`, jsonRequest('POST', { body: 'No' }));
    assert.equal(otherProject.status, 404);

    const invalidJson = await fetch(`${base}/jira/issues`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(invalidJson.status, 400);
  });
  assert.equal(writes, 0);
});

test('Jira 未配置时健康检查仍可用，写入返回 503', async () => {
  await withServer(createLocalServer({ jiraConnection: { configured: false } }), async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const create = await fetch(`${base}/jira/issues`, jsonRequest('POST', {
      summary: 'Test', description: 'Test',
    }));
    assert.equal(create.status, 503);
  });
});

test('写入缺少 issue type 返回 400，Jira 拒绝时不泄露上游正文', async () => {
  let jiraRequests = 0;
  const jiraConnection = createJiraConnection({
    token: 'test-token',
    cloudId: '00000000-0000-0000-0000-000000000001',
    fetchImpl: async () => {
      jiraRequests += 1;
      return new Response('secret test-token', { status: 403 });
    },
  });
  await withServer(createLocalServer({ jiraConnection }), async (base) => {
    const invalid = await fetch(`${base}/jira/issues`, jsonRequest('POST', {
      summary: 'Fix checkout', description: 'Details',
    }));
    assert.equal(invalid.status, 400);
    assert.equal(jiraRequests, 0);

    const rejected = await fetch(`${base}/jira/issues`, jsonRequest('POST', {
      summary: 'Fix checkout', description: 'Details', issueTypeName: 'Bug',
    }));
    assert.equal(rejected.status, 502);
    const payload = await rejected.text();
    assert.match(payload, /Jira 返回 403/);
    assert.ok(!payload.includes('test-token'));
    assert.equal(jiraRequests, 1);
  });
});
