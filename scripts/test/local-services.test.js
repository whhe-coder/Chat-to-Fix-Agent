import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinate } from '../local-services.js';

function actions(events) {
  return {
    startAgent: async () => events.push('start-agent'),
    startMock: async () => events.push('start-mock'),
    stopAgent: async () => events.push('stop-agent'),
    stopMock: async () => events.push('stop-mock'),
    output: (message) => events.push(message),
  };
}

test('启动时先启动 Agent，再启动模拟 Slack', async () => {
  const events = [];
  await coordinate('start', { ...actions(events), autoStartMock: true });
  assert.deepEqual(events, ['start-agent', 'start-mock']);
});

test('MOCK_SLACK_AUTO_START=0 时只启动 Agent', async () => {
  const events = [];
  await coordinate('start', { ...actions(events), autoStartMock: false });
  assert.equal(events[0], 'start-agent');
  assert.equal(events.length, 2);
  assert.match(events[1], /MOCK_SLACK_AUTO_START=0/);
});

test('Agent 已运行时仍会补启动模拟 Slack', async () => {
  const events = [];
  const callbacks = actions(events);
  callbacks.startAgent = async () => events.push('agent-already-running');
  await coordinate('start', { ...callbacks, autoStartMock: true });
  assert.deepEqual(events, ['agent-already-running', 'start-mock']);
});

test('模拟 Slack 启动失败时保留已启动的 Agent', async () => {
  const events = [];
  const callbacks = actions(events);
  callbacks.startMock = async () => { events.push('start-mock'); throw new Error('port occupied'); };
  await assert.rejects(coordinate('start', { ...callbacks, autoStartMock: true }), /port occupied/);
  assert.deepEqual(events, ['start-agent', 'start-mock']);
});

test('停止时先停模拟 Slack，再停 Agent；一个停止失败也继续另一个', async () => {
  const events = [];
  const callbacks = actions(events);
  callbacks.stopMock = async () => { events.push('stop-mock'); throw new Error('mock stop failed'); };
  await assert.rejects(coordinate('stop', callbacks), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, 'mock stop failed');
    return true;
  });
  assert.deepEqual(events, ['stop-mock', 'stop-agent']);
});

test('停止两个服务；无效动作报错', async () => {
  const events = [];
  await coordinate('stop', actions(events));
  assert.deepEqual(events, ['stop-mock', 'stop-agent']);
  await assert.rejects(coordinate('restart', actions([])), /start\|stop/);
});
