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
const compose = document.getElementById('compose');
const customInput = document.getElementById('custom-order');
const composeSubmit = compose.querySelector('button[type="submit"]');

let orderGen = 0;
let abortCtrl = null;
let confirmed = [];
let pendingNames = [];
let receiptMode = 'wait';
let receiptMessage = '';
let totalCount = 0;

const QUANTITY_LABEL = { one: '一份', two: '两份', three: '三份', invalid: '非法' };
const TEMPERATURE_LABEL = { hot: '热', iced: '冰', unspecified: '未说明' };

function setChoicesDisabled(disabled) {
  for (const btn of choices) btn.disabled = disabled;
  customInput.disabled = disabled;
  composeSubmit.disabled = disabled;
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
  receiptMessage = '';
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
  receiptMessage = '';
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
    const message = receiptMessage || (receiptMode === 'fault' ? '未能写入' : '');
    placeholder.hidden = message === '';
    placeholder.textContent = message;
    placeholder.classList.toggle(
      'is-unmet',
      message !== '' && (receiptMode === 'unmet' || receiptMode === 'invalid' || receiptMode === 'empty'),
    );
  } else {
    placeholder.hidden = true;
    placeholder.classList.remove('is-unmet');
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
  if (event.value == null) return '未返回';
  const value = Number(event.value);
  return Number.isFinite(value) ? value.toFixed(2) : String(event.value);
}

function emptyReceipt(event) {
  if (event.outcome === 'invalid_quantity' || event.reason === 'invalid_quantity') {
    receiptMode = 'invalid';
    receiptMessage = event.message || '数量非法，无法满足';
    return;
  }
  receiptMode = event.outcome === 'empty' ? 'empty' : 'unmet';
  receiptMessage = event.message || '不在菜单，菜单无法满足';
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
    const opening = processLog.querySelector('.step--status .step__text');
    if (opening?.textContent === '正在点单…') opening.closest('li')?.remove();
    switch (event.type) {
      case 'choice': {
        const conf =
          typeof event.confidence === 'number' ? event.confidence.toFixed(2) : '';
        if (event.rejected === 'not_on_menu') {
          addStep({ mark: '选择', text: '不在菜单', meta: conf, kind: 'unmet' });
          break;
        }
        if (event.matched?.id === 'done') {
          addStep({
            mark: '选择',
            text: event.offMenu ? '不在菜单' : '没有更多了',
            meta: conf,
            kind: event.offMenu ? 'unmet' : 'done',
          });
          break;
        }
        if (!event.matched?.name) {
          addStep({ mark: '选择', text: '未识别', meta: conf, kind: 'ignored' });
          break;
        }
        addStep({ mark: '选择', text: event.matched.name, meta: conf, kind: 'choice' });
        break;
      }
      case 'quantity':
        addStep({
          mark: '数量',
          text: event.item || '这一项',
          meta: QUANTITY_LABEL[event.quantity] || '未说明',
          kind: 'choice',
        });
        break;
      case 'temperature':
        addStep({
          mark: '温度',
          text: event.item || '这一杯',
          meta: TEMPERATURE_LABEL[event.temperature] || '未说明',
          kind: 'choice',
        });
        break;
      case 'unmet':
        addStep({
          mark: '菜单',
          text: '不在菜单',
          meta: '无法满足',
          kind: 'unmet',
        });
        if (!confirmed.length && !pendingNames.length) {
          receiptMode = 'unmet';
          receiptMessage = event.message || '不在菜单，菜单无法满足';
          renderReceipt();
        }
        break;
      case 'invalid':
        addStep({
          mark: '拒绝',
          text: event.item ? `${event.item} 数量非法` : '数量非法',
          meta: '无法满足',
          kind: 'error',
        });
        break;
      case 'added': {
        const item = event.item || '（未知）';
        const count = Number.isInteger(event.count) && event.count > 0 ? event.count : 1;
        for (let i = 0; i < count; i += 1) pendingNames.push(item);
        renderReceipt();
        addStep({ mark: '加入', text: item, meta: `× ${count}`, kind: 'added' });
        break;
      }
      case 'check': {
        const item = event.item || '（未知）';
        const count = Number.isInteger(event.count) && event.count > 0 ? event.count : 1;
        for (let i = 0; i < count; i += 1) {
          takePending(item);
          if (event.kept) confirmed.push(item);
        }
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
          text: event.empty ? event.message || '不在菜单，菜单无法满足' : '点完了',
          kind: event.empty ? 'unmet' : 'done',
        });
        if (event.empty && !confirmed.length && !pendingNames.length) {
          emptyReceipt(event);
          renderReceipt();
        }
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
        if (names.length) {
          receiptMode = 'items';
          receiptMessage = '';
        } else {
          emptyReceipt(event);
        }
        renderReceipt();
        if (event.stoppedByLimit) {
          addStep({ mark: '停止', text: '达到请求上限', kind: 'status' });
        }
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

customInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.isComposing) event.preventDefault();
});

compose.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = customInput.value.trim();
  customInput.value = text;
  if (!text) {
    customInput.focus();
    return;
  }
  startOrder(text);
});

backBtn.addEventListener('click', showDialog);
