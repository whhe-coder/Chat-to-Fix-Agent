import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../.env.local', import.meta.url));

if (existsSync(path)) {
  if (typeof process.loadEnvFile !== 'function') {
    throw new Error('读取 .env.local 需要支持 process.loadEnvFile 的 Node.js 版本');
  }
  process.loadEnvFile(path);
}
