import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../mock-channel.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../mock-channel-client.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('页面加载默认身份，允许编辑，并把编辑后的身份随 /fix 发送', async () => {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4001/', runScripts: 'outside-only' });
  const { window } = dom;
  const posted = [];
  let refresh;
  window.setInterval = (callback) => { refresh = callback; return 1; };
  Object.defineProperty(window.crypto, 'randomUUID', { value: () => 'test-event' });
  window.fetch = async (path, options) => {
    if (path === '/api/channel') return {
      ok: true,
      json: async () => ({
        channelId: 'CLOCAL', mockUser: { id: 'UMOCK', name: '模拟用户', email: 'default@example.com' },
        agent: { online: true }, threads: [],
      }),
    };
    assert.equal(path, '/api/messages');
    posted.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true, thread: {} }) };
  };
  window.eval(script);
  await tick();

  const id = window.document.querySelector('#mock-user-id');
  const name = window.document.querySelector('#mock-user-name');
  const email = window.document.querySelector('#mock-user-email');
  const send = window.document.querySelector('#send-button');
  assert.deepEqual([id.value, name.value, email.value], ['UMOCK', '模拟用户', 'default@example.com']);
  assert.equal(send.disabled, false);

  id.value = 'W123ABC';
  name.value = '另一位用户';
  email.value = 'other@example.com';
  await refresh();
  await tick();
  assert.deepEqual([id.value, name.value, email.value], ['W123ABC', '另一位用户', 'other@example.com']);

  window.document.querySelector('#message').value = '/fix 登录按钮无响应';
  window.document.querySelector('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.deepEqual(posted[0], {
    text: '/fix 登录按钮无响应', eventId: 'mock:test-event',
    user: { id: 'W123ABC', name: '另一位用户', email: 'other@example.com' },
  });
  dom.window.close();
});
