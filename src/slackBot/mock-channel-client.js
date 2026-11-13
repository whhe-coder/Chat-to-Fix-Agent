const threadsNode = document.querySelector('#threads');
const form = document.querySelector('#composer');
const textarea = document.querySelector('#message');
const sendButton = document.querySelector('#send-button');
const note = document.querySelector('#composer-note');
const status = document.querySelector('#agent-status');
const clearButton = document.querySelector('#clear-history');
const userIdInput = document.querySelector('#mock-user-id');
const userNameInput = document.querySelector('#mock-user-name');
const userEmailInput = document.querySelector('#mock-user-email');
let sending = false;
let refreshPending = false;
let defaultsLoaded = false;
let clearPending = false;
let hasMessages = false;
let historyRevision = 0;
const taskStates = {
  queued: '排队中', running: '处理中', done: '已完成', needs_info: '等待补充',
  failed: '任务失败', timed_out: '已超时', stopped: '已停止', expired: '已过期',
};

function linkLength(candidate) {
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1];
    const unmatchedClosingParen = last === ')' && candidate.slice(0, end).split(')').length > candidate.slice(0, end).split('(').length;
    if (!/[.,!?;:，。！？；：、）】》”’]/u.test(last) && !unmatchedClosingParen) break;
    end -= 1;
  }
  return end;
}

function addLinkedText(node, text) {
  for (const part of String(text).split(/(https?:\/\/[^\s<>]+)/g)) {
    if (!/^https?:\/\//.test(part)) { node.append(document.createTextNode(part)); continue; }
    try {
      const end = linkLength(part);
      const linkText = part.slice(0, end);
      const url = new URL(linkText);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
      const link = document.createElement('a');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = linkText;
      node.append(link);
      if (end < part.length) node.append(document.createTextNode(part.slice(end)));
    } catch { node.append(document.createTextNode(part)); }
  }
}

function messageNode(message, user) {
  const row = document.createElement('div');
  row.className = `message message-${message.from}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = message.from === 'user' ? '你' : message.from === 'bot' ? 'B' : 'A';
  const content = document.createElement('div');
  content.className = 'message-content';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const name = document.createElement('strong');
  name.textContent = message.from === 'user' ? (user?.name || '模拟用户') : message.from === 'bot' ? '模拟 Slack Bot' : 'Chat-to-Fix Agent';
  const time = document.createElement('time');
  if (message.at) {
    time.dateTime = message.at;
    time.textContent = new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  meta.append(name, time);
  const body = document.createElement('div');
  body.className = 'message-text';
  addLinkedText(body, message.text);
  content.append(meta, body);
  row.append(avatar, content);
  return row;
}

function threadNode(thread) {
  const article = document.createElement('article');
  article.className = 'thread';
  const head = document.createElement('div');
  head.className = 'thread-head';
  const title = document.createElement('strong');
  title.textContent = thread.taskId ? `任务 ${thread.taskId}` : '待发送的命令';
  const state = document.createElement('span');
  state.className = `thread-state state-${thread.status}`;
  state.textContent = thread.status === 'failed' ? '发送失败' : taskStates[thread.taskState] || (thread.status === 'pending' ? '发送中' : '已接收');
  head.append(title, state);
  article.append(head);
  for (const message of thread.messages) article.append(messageNode(message, thread.user));
  if (thread.error) {
    const error = document.createElement('div');
    error.className = 'thread-error';
    const text = document.createElement('span');
    text.textContent = thread.error;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试发送';
    retry.addEventListener('click', () => send(thread.command, thread.eventId, thread.user));
    error.append(text, retry);
    article.append(error);
  }
  return article;
}

function render(data) {
  const channel = data.channelId === 'CLOCAL' ? 'chat-to-fix-local' : data.channelId;
  for (const id of ['sidebar-channel', 'channel-title', 'composer-channel']) document.getElementById(id).textContent = channel;
  if (!defaultsLoaded) {
    userIdInput.value = data.mockUser.id;
    userNameInput.value = data.mockUser.name;
    userEmailInput.value = data.mockUser.email;
    defaultsLoaded = true;
    sendButton.disabled = false;
  }
  status.className = `status ${data.agent.online ? 'status-online' : 'status-offline'}`;
  status.textContent = data.agent.online ? 'Agent 已连接' : (data.agent.error || 'Agent 未连接');
  hasMessages = data.threads.length > 0;
  clearButton.disabled = !hasMessages || sending || clearPending;
  threadsNode.replaceChildren(...data.threads.map(threadNode));
}

async function refresh() {
  if (refreshPending) return;
  refreshPending = true;
  const revision = historyRevision;
  try {
    const response = await fetch('/api/channel', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取模拟频道');
    const data = await response.json();
    if (revision === historyRevision) render(data);
  } catch {
    status.className = 'status status-offline';
    status.textContent = '模拟频道服务暂不可用';
  } finally { refreshPending = false; }
}

async function send(command, eventId = `mock:${crypto.randomUUID()}`, retryUser) {
  if (sending) return;
  const user = retryUser ?? { id: userIdInput.value.trim(), name: userNameInput.value.trim(), email: userEmailInput.value.trim() };
  sending = true;
  sendButton.disabled = true;
  clearButton.disabled = true;
  note.textContent = '正在发送…';
  try {
    const response = await fetch('/api/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: command, eventId, user }),
    });
    const result = await response.json();
    if (result.thread) textarea.value = '';
    note.textContent = result.ok ? '已交给 Agent；进度会显示在任务讨论串中' : (result.error || '发送失败');
    await refresh();
  } catch { note.textContent = '模拟频道服务暂不可用，请重试'; }
  finally { sending = false; sendButton.disabled = false; clearButton.disabled = !hasMessages || clearPending; }
}

async function clearHistory() {
  if (clearPending || sending || !hasMessages) return;
  clearPending = true;
  clearButton.disabled = true;
  try {
    const response = await fetch('/api/messages', { method: 'DELETE' });
    if (!response.ok) throw new Error('清空失败');
    historyRevision += 1;
    hasMessages = false;
    threadsNode.replaceChildren();
    note.textContent = '模拟消息记录已清空；Agent 任务仍会继续运行';
    await refresh();
  } catch { note.textContent = '清空失败，请重试'; }
  finally { clearPending = false; clearButton.disabled = !hasMessages; }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  send(textarea.value);
});
textarea.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});
clearButton.addEventListener('click', clearHistory);
refresh();
setInterval(refresh, 2000);
