const DEFAULT_PROJECT = 'account-platform/free-to-play-pc';

export class GitlabApiError extends Error {
  constructor(status) {
    super(`GitLab 返回 ${status}`);
    this.status = status;
  }
}

function positiveId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${name} 必须是正整数`);
  return id;
}

function draftTitle(value) {
  if (typeof value !== 'string') throw new Error('MR 标题不能为空');
  const title = value.trim();
  const prefix = /^(?:Draft:|\[Draft\]|\(Draft\))\s*/i;
  if (!title.replace(prefix, '').trim()) throw new Error('MR 标题不能为空');
  return prefix.test(title) ? title : `Draft: ${title}`;
}

export function createGitlabClient({
  token,
  gitlabUrl = 'https://gitlab.loc',
  project = DEFAULT_PROJECT,
  fetchImpl = fetch,
} = {}) {
  const base = new URL(gitlabUrl);
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('GITLAB_URL 必须是无凭据的 HTTPS 地址');
  }
  const projectPath = `/api/v4/projects/${encodeURIComponent(project)}`;

  async function request(path, { method = 'GET', body, responseType = 'json' } = {}) {
    if (!token) throw new Error('找不到 GitLab token');
    const response = await fetchImpl(new URL(`${projectPath}${path}`, base), {
      method,
      headers: {
        'PRIVATE-TOKEN': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new GitlabApiError(response.status);
    return responseType === 'text' ? response.text() : response.json();
  }

  async function pages(path) {
    if (!token) throw new Error('找不到 GitLab token');
    const items = [];
    for (let page = 1; page <= 10; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await fetchImpl(new URL(`${projectPath}${path}${separator}per_page=100&page=${page}`, base), {
        headers: { 'PRIVATE-TOKEN': token },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new GitlabApiError(response.status);
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error('GitLab 列表响应无效');
      items.push(...batch);
      const next = response.headers.get('x-next-page');
      if (!next) return items;
    }
    throw new Error('GitLab 列表超过可检查的页数');
  }

  async function getMergeRequest(iid) {
    return request(`/merge_requests/${positiveId(iid, 'MR IID')}`);
  }

  async function createDraftMergeRequest({ sourceBranch, title, description = '' }) {
    if (typeof sourceBranch !== 'string' || !sourceBranch.trim() || sourceBranch === 'master') {
      throw new Error('需要非 master 的任务分支');
    }
    if (typeof description !== 'string') throw new Error('MR 描述必须是文本');
    const existing = await pages(`/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}&target_branch=master`);
    const match = existing.find((mr) => mr.source_branch === sourceBranch &&
      mr.target_branch === 'master' &&
      (!mr.source_project_id || mr.source_project_id === mr.target_project_id));
    if (match) {
      if (!match.draft) throw new Error('任务分支已有非 Draft MR');
      return match;
    }
    return request('/merge_requests', {
      method: 'POST',
      body: {
        source_branch: sourceBranch,
        target_branch: 'master',
        title: draftTitle(title),
        description,
      },
    });
  }

  async function updateDraftMergeRequest({ iid, sourceBranch, title, description }) {
    if (typeof sourceBranch !== 'string' || !sourceBranch.trim()) {
      throw new Error('需要任务分支名称');
    }
    if (title === undefined && description === undefined) throw new Error('需要标题或描述');
    if (description !== undefined && typeof description !== 'string') {
      throw new Error('MR 描述必须是文本');
    }
    const mr = await getMergeRequest(iid);
    if (mr.state !== 'opened' || !mr.draft || mr.source_branch !== sourceBranch) {
      throw new Error('只能修改当前任务分支的开放 Draft MR');
    }
    return request(`/merge_requests/${positiveId(iid, 'MR IID')}`, {
      method: 'PUT',
      body: {
        ...(title === undefined ? {} : { title: draftTitle(title) }),
        ...(description === undefined ? {} : { description }),
      },
    });
  }

  async function getMergeRequestChecks(iid) {
    const mr = await getMergeRequest(iid);
    const summary = {
      mr: { iid: mr.iid, title: mr.title, sha: mr.sha, draft: mr.draft, webUrl: mr.web_url },
      status: 'pending',
      parentPipeline: null,
      childPipelines: [],
      failedJobs: [],
    };
    if (mr.state !== 'opened' || !mr.sha) return summary;

    let head = mr.head_pipeline?.sha === mr.sha ? mr.head_pipeline : null;
    if (!head) {
      const pipelines = await pages(`/merge_requests/${positiveId(iid, 'MR IID')}/pipelines`);
      head = pipelines.filter((item) => item.sha === mr.sha &&
        (!item.source || item.source === 'merge_request_event'))
        .sort((a, b) => b.id - a.id)[0];
    }
    if (!head) return summary;

    const parent = await request(`/pipelines/${positiveId(head.id, 'pipeline ID')}`);
    if (parent.sha !== mr.sha) return summary;
    summary.parentPipeline = {
      id: parent.id, sha: parent.sha, status: parent.status, webUrl: parent.web_url,
    };

    const triggers = await pages(`/pipelines/${parent.id}/trigger_jobs`);
    const triggerStatuses = [];
    for (const trigger of triggers) {
      if (trigger.downstream_pipeline?.id) {
        const child = await request(`/pipelines/${positiveId(trigger.downstream_pipeline.id, 'child pipeline ID')}`);
        summary.childPipelines.push({
          id: child.id, sha: child.sha, status: child.status, webUrl: child.web_url,
        });
        triggerStatuses.push(child.sha === mr.sha ? child.status : 'pending');
      } else {
        triggerStatuses.push(trigger.status);
        if (trigger.status === 'failed') {
          summary.failedJobs.push({
            id: trigger.id, name: trigger.name, pipelineId: parent.id, webUrl: trigger.web_url,
          });
        }
      }
    }

    const statuses = [parent.status, ...triggerStatuses];
    for (const pipeline of [summary.parentPipeline, ...summary.childPipelines]) {
      const jobs = await pages(`/pipelines/${pipeline.id}/jobs`);
      summary.failedJobs.push(...jobs.filter((job) => job.status === 'failed').map((job) => ({
        id: job.id, name: job.name, pipelineId: pipeline.id, webUrl: job.web_url,
      })));
    }
    if (summary.failedJobs.length || statuses.some((status) => status === 'failed' || status === 'canceled')) {
      summary.status = 'failed';
    } else if (statuses.every((status) => status === 'success')) summary.status = 'passed';
    return summary;
  }

  return {
    getBranch: (branch = 'master') => request(`/repository/branches/${encodeURIComponent(branch)}`),
    getMergeRequest,
    createDraftMergeRequest,
    updateDraftMergeRequest,
    getMergeRequestChecks,
    getJobTrace: (id) => request(`/jobs/${positiveId(id, 'job ID')}/trace`, { responseType: 'text' }),
  };
}
