import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { startMockService, stopMockService } from '../mock-channel-service.js';

const execFileAsync = promisify(execFile);

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'chat-to-fix-startup-test-'));
  const agentData = join(root, 'agent-data');
  mkdirSync(agentData);
  writeFileSync(join(agentData, 'http-token'), 'test-token\n', { mode: 0o600 });
  const requests = [];
  const agent = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    assert.equal(request.headers['x-chat-to-fix-token'], 'test-token');
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url?.startsWith('/outbox')) response.end('{"messages":[],"next":0}');
    else if (request.url === '/tasks') response.end('{"tasks":[]}');
    else response.end('{}');
  });
  const agentPort = await listen(agent);
  const mockPort = await freePort();
  const env = {
    ...process.env,
    CHAT_TO_FIX_DATA: agentData,
    MOCK_SLACK_STATE_DIR: join(root, 'mock-data'),
    MOCK_SLACK_AGENT_URL: `http://127.0.0.1:${agentPort}`,
    MOCK_SLACK_PORT: String(mockPort),
    CHAT_TO_FIX_SLACK_CHANNEL: 'CLOCAL',
  };
  const pidFile = join(env.MOCK_SLACK_STATE_DIR, 'run/mock-slack.pid');
  t.after(async () => {
    if (existsSync(pidFile)) await stopMockService(env);
    agent.closeAllConnections();
    await new Promise((resolve) => agent.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { env, pidFile, mockPort, agentPort, requests };
}

async function npm(command, env) {
  const { stdout } = await execFileAsync('npm', command, {
    cwd: resolve(import.meta.dirname, '../../..'), env, encoding: 'utf8',
  });
  return stdout;
}

test('首次启动、重复启动和停止；页面连接 CLOCAL 且不发送 /fix', async (t) => {
  const { env, pidFile, mockPort, requests } = await fixture(t);
  await startMockService(env);
  const first = JSON.parse(readFileSync(pidFile, 'utf8'));
  assert.ok(first.pid > 0);
  const page = await fetch(`http://127.0.0.1:${mockPort}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /模拟频道/);
  const channel = await (await fetch(`http://127.0.0.1:${mockPort}/api/channel`)).json();
  assert.equal(channel.channelId, 'CLOCAL');
  assert.equal(channel.agent.online, true);
  await startMockService(env);
  assert.equal(JSON.parse(readFileSync(pidFile, 'utf8')).pid, first.pid);
  const denied = await fetch(`http://127.0.0.1:${mockPort}/_service/shutdown`, {
    method: 'POST', headers: { 'x-mock-service-id': 'wrong-id' },
  });
  assert.equal(denied.status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${mockPort}/`)).status, 200);
  await npm(['run', 'stop:agent'], env);
  assert.equal((await fetch(`http://127.0.0.1:${mockPort}/`)).status, 200);
  assert.ok(requests.every((request) => request.startsWith('GET ')));
  await stopMockService(env);
  assert.equal(existsSync(pidFile), false);
  await assert.rejects(fetch(`http://127.0.0.1:${mockPort}/`));
  await stopMockService(env);
});

test('npm stop 停止模拟页面并执行 Agent 停止流程', async (t) => {
  const { env, pidFile, mockPort } = await fixture(t);
  await startMockService(env);
  const output = await npm(['stop'], env);
  assert.match(output, /模拟 Slack 频道已停止/);
  assert.match(output, /chat-to-fix: not running \(no pid file\)/);
  assert.equal(existsSync(pidFile), false);
  await assert.rejects(fetch(`http://127.0.0.1:${mockPort}/`));
});

test('其他程序占用端口时明确报错，Agent 保持运行', async (t) => {
  const { env, pidFile, agentPort } = await fixture(t);
  const occupied = createServer((request, response) => response.end('unrelated'));
  occupied.listen(Number(env.MOCK_SLACK_PORT), '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => occupied.close());
  await assert.rejects(startMockService(env), /端口 .* 已被占用/);
  assert.equal(existsSync(pidFile), false);
  assert.equal((await fetch(`http://127.0.0.1:${agentPort}/tasks`, { headers: { 'x-chat-to-fix-token': 'test-token' } })).status, 200);
});

test('Agent 不可达时启动失败，并清理模拟服务及 PID 文件', async (t) => {
  const { env, pidFile, mockPort } = await fixture(t);
  env.MOCK_SLACK_AGENT_URL = `http://127.0.0.1:${await freePort()}`;
  await assert.rejects(startMockService(env), /未能连接当前 Agent/);
  assert.equal(existsSync(pidFile), false);
  await assert.rejects(fetch(`http://127.0.0.1:${mockPort}/`));
});

test('PID 归属无法确认时拒绝停止，并保留 PID 文件', async (t) => {
  const { env, pidFile } = await fixture(t);
  mkdirSync(join(env.MOCK_SLACK_STATE_DIR, 'run'), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: Number(env.MOCK_SLACK_PORT), id: '00000000-0000-0000-0000-000000000000' }));
  await assert.rejects(stopMockService(env), /无法确认归属/);
  assert.equal(existsSync(pidFile), true);
  rmSync(pidFile);
});
