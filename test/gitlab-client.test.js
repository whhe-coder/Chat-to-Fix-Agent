import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitlabClient } from '../src/server/gitlab-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

test('创建 Draft MR 前检查任务分支，并只提交 Draft 标题和描述', async () => {
  const calls = [];
  const client = createGitlabClient({
    token: 'test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      if (options.method === 'POST') return json({ iid: 12, draft: true });
      return json([]);
    },
  });

  const result = await client.createDraftMergeRequest({
    sourceBranch: 'ai/F2PGBA-123',
    title: 'F2PGBA-123 修复登录',
    description: '修复登录流程',
  });
  assert.equal(result.iid, 12);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /source_branch=ai%2FF2PGBA-123/);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    source_branch: 'ai/F2PGBA-123',
    target_branch: 'master',
    title: 'Draft: F2PGBA-123 修复登录',
    description: '修复登录流程',
  });
  assert.equal(calls[1].options.headers['PRIVATE-TOKEN'], 'test-token');
});

test('只修改当前任务分支的开放 Draft MR', async () => {
  const calls = [];
  const client = createGitlabClient({
    token: 'test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      if (options.method === 'PUT') return json({ iid: 12, title: 'Draft: 新标题' });
      return json({ iid: 12, state: 'opened', draft: true, source_branch: 'ai/F2PGBA-123' });
    },
  });
  await client.updateDraftMergeRequest({
    iid: 12,
    sourceBranch: 'ai/F2PGBA-123',
    title: '新标题',
    description: '新的说明',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    title: 'Draft: 新标题',
    description: '新的说明',
  });
  await assert.rejects(client.updateDraftMergeRequest({
    iid: 12, sourceBranch: 'ai/other', title: '错误分支',
  }), /当前任务分支/);
  assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 1);
});

test('旧 commit 的成功 pipeline 不能代表当前 MR 通过', async () => {
  const client = createGitlabClient({
    token: 'test-token',
    fetchImpl: async (url) => {
      if (url.pathname.endsWith('/merge_requests/12')) {
        return json({ iid: 12, state: 'opened', sha: 'new-sha', head_pipeline: { id: 4, sha: 'old-sha' } });
      }
      if (url.pathname.endsWith('/merge_requests/12/pipelines')) {
        return json([{ id: 4, sha: 'old-sha', status: 'success' }]);
      }
      throw new Error(`不应读取旧 pipeline：${url.pathname}`);
    },
  });
  const result = await client.getMergeRequestChecks(12);
  assert.equal(result.status, 'pending');
  assert.equal(result.parentPipeline, null);
});

test('主 pipeline 成功但下游 E2E 失败时报告失败 job', async () => {
  const client = createGitlabClient({
    token: 'test-token',
    fetchImpl: async (url) => {
      const path = url.pathname;
      if (path.endsWith('/merge_requests/12')) {
        return json({
          iid: 12, state: 'opened', draft: true, sha: 'current-sha',
          head_pipeline: { id: 10, sha: 'current-sha' },
        });
      }
      if (path.endsWith('/pipelines/10')) return json({ id: 10, sha: 'current-sha', status: 'success' });
      if (path.endsWith('/pipelines/10/trigger_jobs')) {
        return json([{ id: 20, status: 'success', downstream_pipeline: { id: 11 } }]);
      }
      if (path.endsWith('/pipelines/11')) return json({ id: 11, sha: 'current-sha', status: 'failed' });
      if (path.endsWith('/pipelines/10/jobs')) return json([]);
      if (path.endsWith('/pipelines/11/jobs')) {
        return json([{ id: 99, name: 'e2e', status: 'failed', web_url: 'https://gitlab.loc/job/99' }]);
      }
      if (path.endsWith('/jobs/99/trace')) return new Response('测试失败详情');
      throw new Error(`意外的 API：${path}`);
    },
  });
  const result = await client.getMergeRequestChecks(12);
  assert.equal(result.status, 'failed');
  assert.equal(result.parentPipeline.status, 'success');
  assert.equal(result.childPipelines[0].status, 'failed');
  assert.deepEqual(result.failedJobs, [{
    id: 99, name: 'e2e', pipelineId: 11, webUrl: 'https://gitlab.loc/job/99',
  }]);
  assert.equal(await client.getJobTrace(99), '测试失败详情');
});

test('pipeline 显示成功但内部有失败 job 时不宣称全部通过', async () => {
  const client = createGitlabClient({
    token: 'test-token',
    fetchImpl: async (url) => {
      const path = url.pathname;
      if (path.endsWith('/merge_requests/12')) {
        return json({
          iid: 12, state: 'opened', draft: true, sha: 'current-sha',
          head_pipeline: { id: 10, sha: 'current-sha' },
        });
      }
      if (path.endsWith('/pipelines/10')) return json({ id: 10, sha: 'current-sha', status: 'success' });
      if (path.endsWith('/pipelines/10/trigger_jobs')) return json([]);
      if (path.endsWith('/pipelines/10/jobs')) {
        return json([{ id: 88, name: 'optional-check', status: 'failed' }]);
      }
      throw new Error(`意外的 API：${path}`);
    },
  });
  const result = await client.getMergeRequestChecks(12);
  assert.equal(result.status, 'failed');
  assert.equal(result.failedJobs[0].id, 88);
});
