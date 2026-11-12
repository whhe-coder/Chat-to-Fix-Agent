import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const startPath = fileURLToPath(new URL('../src/server/start.js', import.meta.url));

test('PORT=0 时启动日志报告实际端口，服务可访问', async (t) => {
  const child = spawn(process.execPath, [startPath], {
    env: { ...process.env, PORT: '0', GITLAB_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('服务未在 5 秒内报告监听端口'));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`服务在报告端口前退出：${code}`));
    });
  });

  assert.notEqual(new URL(base).port, '0');
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('无效 PORT 不能启动本地服务', () => {
  for (const port of ['abc', '-1', '1.5', '65536']) {
    const result = spawnSync(process.execPath, [startPath], {
      env: { ...process.env, PORT: port, GITLAB_TOKEN: 'test-token' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.notEqual(result.status, 0, `PORT=${port} 不应启动`);
    assert.match(result.stderr, /ERR_SOCKET_BAD_PORT/);
  }
});
