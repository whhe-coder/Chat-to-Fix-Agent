import '../load-local-env.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = join(ROOT, 'src/slackBot/start-mock-channel.js');

function settings(env) {
  const port = Number(env.MOCK_SLACK_PORT || 4001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MOCK_SLACK_PORT 必须是 1 到 65535 的整数');
  const agentData = resolve(env.CHAT_TO_FIX_DATA || join(ROOT, 'src/chat-to-fix/.data/connected'));
  const state = resolve(env.MOCK_SLACK_STATE_DIR || join(ROOT, 'src/slackBot/.data'));
  const run = join(state, 'run');
  return { port, agentData, run, pidFile: join(run, 'mock-slack.pid'), logFile: join(run, 'mock-slack.log') };
}

function recordOf(path) {
  if (!existsSync(path)) return null;
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`模拟 Slack PID 文件无效：${path}`); }
  if (!Number.isInteger(record?.pid) || record.pid < 1 || !Number.isInteger(record.port)
    || record.port < 1 || typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.id)) {
    throw new Error(`模拟 Slack PID 文件无效：${path}`);
  }
  return record;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

async function identity(record) {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/_service/identity`, {
      headers: { 'x-mock-service-id': record.id }, signal: AbortSignal.timeout(1000),
    });
    return response.ok && (await response.json()).id === record.id;
  } catch { return false; }
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open) => { if (settled) return; settled = true; socket.destroy(); done(open); };
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(1000, () => finish(true));
  });
}

async function ready(record, channel) {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/channel`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    return response.ok && body.agent?.online === true && body.channelId === channel;
  } catch { return false; }
}

async function spawned(child) {
  return new Promise((done, reject) => {
    child.once('error', reject);
    child.once('spawn', () => done(child.pid));
  });
}

async function shutdown(record) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${record.port}/_service/shutdown`, {
      method: 'POST', headers: { 'x-mock-service-id': record.id }, signal: AbortSignal.timeout(2000),
    });
  } catch (error) { throw new Error(`无法请求模拟 Slack 停止：${error.cause?.code || error.code || error.name}`); }
  if (response.status !== 202) throw new Error(`模拟 Slack 拒绝停止请求（HTTP ${response.status}）`);
  for (let i = 0; i < 25 && alive(record.pid); i += 1) await delay(100);
  if (alive(record.pid)) throw new Error(`模拟 Slack PID ${record.pid} 未停止`);
}

export async function startMockService(env = process.env) {
  const s = settings(env);
  mkdirSync(s.run, { recursive: true, mode: 0o700 });
  const existing = recordOf(s.pidFile);
  if (existing) {
    if (alive(existing.pid)) {
      if (!await identity(existing)) throw new Error(`模拟 Slack PID ${existing.pid} 无法确认归属；不会停止或复用该进程`);
      if (existing.port !== s.port) throw new Error(`模拟 Slack 已在端口 ${existing.port} 运行；请先停止再改用端口 ${s.port}`);
      if (!await ready(existing, env.CHAT_TO_FIX_SLACK_CHANNEL || 'CLOCAL')) {
        throw new Error('模拟 Slack 已运行，但未连接当前 Agent 或频道不匹配');
      }
      console.log(`模拟 Slack 频道已运行：http://127.0.0.1:${existing.port}/`);
      return;
    }
    rmSync(s.pidFile);
  }
  if (await portOpen(s.port)) throw new Error(`模拟 Slack 端口 ${s.port} 已被占用；不会接管该进程。如已有模拟页面，可检查 http://127.0.0.1:${s.port}/`);

  const id = randomUUID();
  const fd = openSync(s.logFile, 'a', 0o600);
  chmodSync(s.logFile, 0o600);
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT, env: { ...env, CHAT_TO_FIX_DATA: s.agentData, MOCK_SLACK_SERVICE_ID: id },
    detached: true, stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const pid = await spawned(child);
  const record = { pid, port: s.port, id };
  writeFileSync(s.pidFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  child.unref();
  try {
    for (let i = 0; i < 10; i += 1) {
      if (!alive(pid)) throw new Error(await portOpen(s.port) ? `模拟 Slack 端口 ${s.port} 已被占用` : `模拟 Slack 启动失败；查看 ${s.logFile}`);
      if (await identity(record) && await ready(record, env.CHAT_TO_FIX_SLACK_CHANNEL || 'CLOCAL')) {
        console.log(`模拟 Slack 频道：http://127.0.0.1:${s.port}/`);
        return;
      }
      await delay(200);
    }
    throw new Error(`模拟 Slack 未能连接当前 Agent；查看 ${s.logFile}`);
  } catch (error) {
    try {
      if (await identity(record)) await shutdown(record);
      else if (alive(pid)) {
        process.kill(pid, 'SIGTERM');
        for (let i = 0; i < 25 && alive(pid); i += 1) await delay(100);
        if (alive(pid)) throw new Error(`模拟 Slack PID ${pid} 未停止`);
      }
      rmSync(s.pidFile, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `模拟 Slack 启动失败，且后台进程未清理（${cleanupError.message}）；PID 文件保留在 ${s.pidFile}`);
    }
    throw error;
  }
}

export async function stopMockService(env = process.env) {
  const s = settings(env);
  const record = recordOf(s.pidFile);
  if (!record) {
    if (await portOpen(s.port)) throw new Error(`模拟 Slack 端口 ${s.port} 仍被占用，但没有 PID 文件；不会停止未知进程`);
    console.log('模拟 Slack 频道未运行（无 PID 文件）');
    return;
  }
  if (!alive(record.pid)) {
    rmSync(s.pidFile);
    console.log('模拟 Slack 频道未运行（已清理旧 PID 文件）');
    return;
  }
  if (!await identity(record)) throw new Error(`模拟 Slack PID ${record.pid} 无法确认归属；不会停止该进程`);
  await shutdown(record);
  rmSync(s.pidFile);
  console.log('模拟 Slack 频道已停止');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const work = action === 'start' ? startMockService : action === 'stop' ? stopMockService : null;
  if (!work) { console.error('用法：node src/slackBot/mock-channel-service.js start|stop'); process.exitCode = 2; }
  else work().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
