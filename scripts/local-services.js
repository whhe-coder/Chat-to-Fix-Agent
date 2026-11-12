import '../src/load-local-env.js';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(label, command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${label} 退出：${signal || code}`));
    });
  });
}

export async function coordinate(action, { autoStartMock, startAgent, startMock, stopAgent, stopMock, output = console.log }) {
  if (action === 'start') {
    await startAgent();
    if (autoStartMock) await startMock();
    else output('已按 MOCK_SLACK_AUTO_START=0 跳过模拟 Slack 页面。');
    return;
  }
  if (action === 'stop') {
    const errors = [];
    try { await stopMock(); } catch (error) { errors.push(error); }
    try { await stopAgent(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '本地服务未全部停止');
    return;
  }
  throw new Error('用法：node scripts/local-services.js start|stop');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  coordinate(action, {
    autoStartMock: process.env.MOCK_SLACK_AUTO_START !== '0',
    startAgent: () => run('Agent 启动', process.execPath, [join(ROOT, 'src/chat-to-fix/scripts/connected.ts'), '--start']),
    startMock: () => run('模拟 Slack 启动', process.execPath, [join(ROOT, 'src/slackBot/mock-channel-service.js'), 'start']),
    stopMock: () => run('模拟 Slack 停止', process.execPath, [join(ROOT, 'src/slackBot/mock-channel-service.js'), 'stop']),
    stopAgent: () => run('Agent 停止', 'sh', [join(ROOT, 'src/chat-to-fix/scripts/stop-chat-to-fix.sh')]),
  }).catch((error) => {
    console.error(error instanceof AggregateError ? `${error.message}: ${error.errors.map((e) => e.message).join('; ')}` : error.message);
    process.exitCode = 1;
  });
}
