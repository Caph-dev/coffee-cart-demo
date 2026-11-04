const dialog = document.getElementById('dialog');
const result = document.getElementById('result');
const requestEl = document.getElementById('result-request');
const backBtn = document.getElementById('ticket-back');
const processLog = document.getElementById('process-log');
const receiptLines = document.getElementById('receipt-lines');
const placeholder = document.getElementById('receipt-placeholder');
const totalEl = document.getElementById('receipt-total');
const totalValue = document.getElementById('receipt-total-value');
const choices = [...document.querySelectorAll('.choice')];

let orderGen = 0;
let abortCtrl = null;
let confirmed = [];
let pendingNames = [];
let receiptMode = 'wait';
let totalCount = 0;

function setChoicesDisabled(disabled) {
  for (const btn of choices) btn.disabled = disabled;
}

function groupCounts(names) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()];
}

function showDialog() {
  orderGen += 1;
  abortCtrl?.abort();
  abortCtrl = null;
  result.hidden = true;
  dialog.hidden = false;
  requestEl.textContent = '';
  processLog.replaceChildren();
  confirmed = [];
  pendingNames = [];
  receiptMode = 'wait';
  totalCount = 0;
  renderReceipt();
  setChoicesDisabled(false);
}

function showResult(request) {
  dialog.hidden = true;
  result.hidden = false;
  requestEl.textContent = request;
  processLog.replaceChildren();
  confirmed = [];
  pendingNames = [];
  receiptMode = 'wait';
  totalCount = 0;
  renderReceipt();
}

function addStep({ mark, text, meta = '', kind = 'status' }) {
  const li = document.createElement('li');
  li.className = `step step--${kind}`;
  const markEl = document.createElement('span');
  markEl.className = 'step__mark';
  markEl.textContent = mark;
  const textEl = document.createElement('span');
  textEl.className = 'step__text';
  textEl.textContent = text;
  li.append(markEl, textEl);
  if (meta) {
    const metaEl = document.createElement('span');
    metaEl.className = 'step__meta';
    metaEl.textContent = meta;
    li.append(metaEl);
  }
  processLog.append(li);
  processLog.scrollTop = processLog.scrollHeight;
}

function receiptRows() {
  const rows = groupCounts(confirmed).map(([name, count]) => ({
    key: `ok:${name}`,
    name,
    right: `× ${count}`,
    pending: false,
  }));
  for (const [name, count] of groupCounts(pendingNames)) {
    rows.push({
      key: `pend:${name}`,
      name,
      right: count > 1 ? `× ${count}` : '核对中',
      pending: true,
    });
  }
  return rows;
}

function fillLine(li, row, isNew) {
  li.className = 'receipt__line' + (row.pending ? ' is-pending' : '') + (isNew ? ' is-new' : '');
  li.dataset.key = row.key;
  let nameEl = li.querySelector('.receipt__name');
  let leader = li.querySelector('.receipt__leader');
  let qty = li.querySelector('.receipt__qty');
  if (!nameEl) {
    nameEl = document.createElement('span');
    nameEl.className = 'receipt__name';
    leader = document.createElement('span');
    leader.className = 'receipt__leader';
    leader.setAttribute('aria-hidden', 'true');
    qty = document.createElement('span');
    qty.className = 'receipt__qty';
    li.append(nameEl, leader, qty);
  }
  nameEl.textContent = row.name;
  qty.textContent = row.right;
}

function renderReceipt() {
  const rows = receiptRows();
  if (!rows.length) {
    receiptLines.replaceChildren();
    placeholder.hidden = false;
    placeholder.textContent =
      receiptMode === 'fault' ? '未能写入' : receiptMode === 'empty' ? '（空票）' : '等待确认…';
  } else {
    placeholder.hidden = true;
    const existing = new Map(
      [...receiptLines.querySelectorAll('.receipt__line')].map((li) => [li.dataset.key, li]),
    );
    const keep = new Set(rows.map((row) => row.key));
    for (const [key, li] of existing) {
      if (!keep.has(key)) li.remove();
    }
    for (const row of rows) {
      const prev = existing.get(row.key);
      const li = prev || document.createElement('li');
      fillLine(li, row, !prev);
      receiptLines.append(li);
    }
  }

  const showTotal = receiptMode === 'items';
  totalEl.hidden = !showTotal;
  if (showTotal) totalValue.textContent = `${totalCount} 件`;
}

function takePending(item) {
  const index = pendingNames.lastIndexOf(item);
  if (index >= 0) pendingNames.splice(index, 1);
}

function namesFromFinal(event) {
  if (Array.isArray(event.cart)) return event.cart.filter((name) => typeof name === 'string');
  if (!Array.isArray(event.items)) return [];
  const names = [];
  for (const item of event.items) {
    if (!item || typeof item.name !== 'string') continue;
    const count = Number.isFinite(item.count) ? item.count : 1;
    for (let i = 0; i < count; i += 1) names.push(item.name);
  }
  return names;
}

function formatCheck(event) {
  if (event.value == null || !event.kind) return '—';
  const value = Number(event.value);
  return `${event.kind} ${Number.isFinite(value) ? value.toFixed(2) : event.value}`;
}

async function runOrder(request, gen, signal) {
  showResult(request);
  addStep({ mark: '点单', text: '正在点单…', kind: 'status' });

  const response = await fetch('/api/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ request }),
    signal,
  });

  if (gen !== orderGen) return;

  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawFinal = false;

  const handleEvent = (event) => {
    if (gen !== orderGen) return;
    switch (event.type) {
      case 'choice': {
        const label = event.matched?.name || event.raw || '（空）';
        const conf =
          typeof event.confidence === 'number' ? event.confidence.toFixed(2) : '';
        addStep({ mark: '选择', text: label, meta: conf, kind: 'choice' });
        break;
      }
      case 'added': {
        const item = event.item || '（未知）';
        pendingNames.push(item);
        renderReceipt();
        addStep({ mark: '加入', text: item, kind: 'added' });
        break;
      }
      case 'check': {
        const item = event.item || '（未知）';
        takePending(item);
        if (event.kept) confirmed.push(item);
        renderReceipt();
        addStep({
          mark: event.kept ? '保留' : '移除',
          text: item,
          meta: formatCheck(event),
          kind: event.kept ? 'keep' : 'reject',
        });
        break;
      }
      case 'ignored':
        addStep({ mark: '忽略', text: '不在菜单', kind: 'ignored' });
        break;
      case 'done':
        addStep({
          mark: '收票',
          text: event.empty ? '菜单无法满足' : '点完了',
          kind: 'done',
        });
        break;
      case 'stop':
        addStep({
          mark: '停止',
          text: event.reason === 'reject_streak' ? '同一件连续未通过，停止' : '无法识别，停止',
          kind: 'status',
        });
        break;
      case 'final': {
        sawFinal = true;
        const names = namesFromFinal(event);
        confirmed = names;
        pendingNames = [];
        totalCount = typeof event.total === 'number' ? event.total : names.length;
        receiptMode = names.length ? 'items' : 'empty';
        renderReceipt();
        break;
      }
      case 'error':
        throw new Error(event.message || '点单失败');
      default:
        break;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (gen !== orderGen) {
      await reader.cancel();
      return;
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === '{}') continue;
      handleEvent(JSON.parse(payload));
    }
  }

  if (gen === orderGen && !sawFinal) addStep({ mark: '结束', text: '连接结束', kind: 'status' });
}

async function startOrder(request) {
  const text = (request || '').trim();
  if (!text) return;
  const gen = ++orderGen;
  abortCtrl?.abort();
  abortCtrl = new AbortController();
  setChoicesDisabled(true);
  try {
    await runOrder(text, gen, abortCtrl.signal);
  } catch (error) {
    if (error.name === 'AbortError' || gen !== orderGen) return;
    if (result.hidden) showResult(text);
    addStep({ mark: '出错', text: error.message || '出错了', kind: 'error' });
    if (!confirmed.length && !pendingNames.length) {
      receiptMode = 'fault';
      renderReceipt();
    }
  } finally {
    if (gen === orderGen) setChoicesDisabled(false);
  }
}

for (const btn of choices) {
  btn.addEventListener('click', () => startOrder(btn.dataset.request || btn.textContent));
}

backBtn.addEventListener('click', showDialog);
