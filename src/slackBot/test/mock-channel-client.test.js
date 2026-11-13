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

test('消息中的链接不包含紧随其后的中英文标点', async () => {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4001/', runScripts: 'outside-only' });
  const { window } = dom;
  window.setInterval = () => 1;
  window.fetch = async () => ({
    ok: true,
    json: async () => ({
      channelId: 'CLOCAL', mockUser: { id: 'UMOCK', name: '模拟用户', email: 'default@example.com' },
      agent: { online: true },
      threads: [{ taskId: 'T-10', taskState: 'running', status: 'sent', messages: [
        { from: 'agent', text: 'Jira 单已建好：F2PGBA-405（https://xsolla.atlassian.net/browse/F2PGBA-405）。' },
        { from: 'agent', text: 'Draft MR opened (https://gitlab.example.com/team/repo/-/merge_requests/12).' },
        { from: 'agent', text: 'Reference: https://example.com/wiki/Page_(test).' },
      ] }],
    }),
  });
  window.eval(script);
  await tick();

  const links = [...window.document.querySelectorAll('.message-text a')];
  assert.deepEqual(links.map((link) => link.href), [
    'https://xsolla.atlassian.net/browse/F2PGBA-405',
    'https://gitlab.example.com/team/repo/-/merge_requests/12',
    'https://example.com/wiki/Page_(test)',
  ]);
  assert.equal(links[0].parentNode.textContent, 'Jira 单已建好：F2PGBA-405（https://xsolla.atlassian.net/browse/F2PGBA-405）。');
  dom.window.close();
});

test('清空记录按钮移除当前讨论串并允许继续输入', async () => {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4001/', runScripts: 'outside-only' });
  const { window } = dom;
  window.setInterval = () => 1;
  let threads = [{ taskId: 'T-1', taskState: 'running', status: 'sent', messages: [
    { from: 'user', text: '/fix 测试任务' },
  ] }];
  const methods = [];
  window.fetch = async (path, options = {}) => {
    assert.ok(['/api/channel', '/api/messages'].includes(path));
    methods.push(options.method ?? 'GET');
    if (options.method === 'DELETE') {
      threads = [];
      return { ok: true };
    }
    return { ok: true, json: async () => ({
      channelId: 'CLOCAL', mockUser: { id: 'UMOCK', name: '模拟用户', email: 'default@example.com' },
      agent: { online: true }, threads,
    }) };
  };
  window.eval(script);
  await tick();

  const clear = window.document.querySelector('#clear-history');
  assert.equal(clear.disabled, false);
  assert.equal(window.document.querySelectorAll('.thread').length, 1);
  clear.click();
  await tick();
  assert.deepEqual(methods, ['GET', 'DELETE', 'GET']);
  assert.equal(window.document.querySelectorAll('.thread').length, 0);
  assert.equal(clear.disabled, true);
  assert.match(window.document.querySelector('#composer-note').textContent, /已清空/);
  assert.equal(window.document.querySelector('#send-button').disabled, false);
  dom.window.close();
});
