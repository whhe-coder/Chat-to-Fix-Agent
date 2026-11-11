import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitlabServer } from '../src/server/gitlab-server.js';

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('健康检查不依赖 GitLab token', async () => {
  await withServer(createGitlabServer({ token: '' }), async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const status = await fetch(`${base}/gitlab/status`);
    assert.equal(status.status, 503);
  });
});

test('用 token 读取指定私有仓库的分支，不在响应中返回 token', async () => {
  const token = 'secret-test-token';
  let requestedUrl;
  let requestedToken;
  const server = createGitlabServer({
    token,
    fetchImpl: async (url, options) => {
      requestedUrl = url.toString();
      requestedToken = options.headers['PRIVATE-TOKEN'];
      return new Response(JSON.stringify({ name: 'master', commit: { id: 'abc123' } }), {
        status: 200,
      });
    },
  });
  await withServer(server, async (base) => {
    const result = await fetch(`${base}/gitlab/status`);
    const body = await result.text();
    assert.equal(result.status, 200);
    assert.equal(requestedToken, token);
    assert.equal(new URL(requestedUrl).host, 'gitlab.loc');
    assert.match(requestedUrl, /projects\/account-platform%2Ffree-to-play-pc\/repository\/branches\/master/);
    assert.deepEqual(JSON.parse(body), {
      ok: true,
      project: 'account-platform/free-to-play-pc',
      branch: 'master',
      commit: 'abc123',
    });
    assert.ok(!body.includes(token));
  });
});

test('GitLab 错误响应不回传上游正文', async () => {
  const token = 'secret-test-token';
  const server = createGitlabServer({
    token,
    fetchImpl: async () => new Response(`upstream error ${token}`, { status: 401 }),
  });
  await withServer(server, async (base) => {
    const result = await fetch(`${base}/gitlab/status`);
    const body = await result.text();
    assert.equal(result.status, 502);
    assert.match(body, /GitLab 返回 401/);
    assert.ok(!body.includes(token));
  });
});
