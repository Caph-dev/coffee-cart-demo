const dialog = document.getElementById('dialog');
const ticket = document.getElementById('ticket');
const lines = document.getElementById('ticket-lines');
const requestEl = document.getElementById('ticket-request');
const backBtn = document.getElementById('ticket-back');
const choices = [...document.querySelectorAll('.choice')];

function setChoicesDisabled(disabled) {
  for (const btn of choices) btn.disabled = disabled;
}

function showDialog() {
  ticket.hidden = true;
  dialog.hidden = false;
  lines.innerHTML = '';
  requestEl.textContent = '';
  setChoicesDisabled(false);
}

function showTicket(request) {
  dialog.hidden = true;
  ticket.hidden = false;
  requestEl.textContent = request;
  lines.innerHTML = '';
}

function addLine({ left, right = '', kind = '' }, delayIndex = 0) {
  const li = document.createElement('li');
  li.className = 'ticket__line' + (kind ? ` ticket__line--${kind}` : '');
  li.style.animationDelay = `${delayIndex * 70}ms`;
  const a = document.createElement('span');
  a.textContent = left;
  li.appendChild(a);
  if (right) {
    const b = document.createElement('span');
    b.textContent = right;
    li.appendChild(b);
  }
  lines.appendChild(li);
}

function summarize(cart) {
  const counts = new Map();
  for (const name of cart) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()];
}

async function runOrder(request) {
  showTicket(request);
  addLine({ left: '正在点单…', kind: 'status' }, 0);

  const response = await fetch('/api/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ request }),
  });

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
  let lineIndex = 1;
  let sawFinal = false;

  const handleEvent = (event) => {
    switch (event.type) {
      case 'choice': {
        const label = event.matched?.name || event.raw || '（空）';
        const conf =
          typeof event.confidence === 'number' ? event.confidence.toFixed(2) : '';
        addLine({ left: `选择 ${label}`, right: conf, kind: 'status' }, lineIndex++);
        break;
      }
      case 'added':
        addLine({ left: event.item, right: '加入' }, lineIndex++);
        break;
      case 'check':
        if (event.kept) {
          addLine(
            {
              left: `保留 ${event.item}`,
              right: event.value == null ? '—' : `${event.kind} ${event.value.toFixed(2)}`,
              kind: 'status',
            },
            lineIndex++,
          );
        } else {
          addLine(
            {
              left: `移除 ${event.item}`,
              right: `${event.kind} ${event.value.toFixed(2)}`,
              kind: 'reject',
            },
            lineIndex++,
          );
        }
        break;
      case 'ignored':
        addLine({ left: '本轮忽略：不在菜单', kind: 'status' }, lineIndex++);
        break;
      case 'done':
        addLine(
          {
            left: event.empty ? '菜单无法满足，收票' : '点完了，收票',
            kind: 'status',
          },
          lineIndex++,
        );
        break;
      case 'final': {
        sawFinal = true;
        const items = event.items?.length
          ? event.items
          : summarize(event.cart || []).map(([name, count]) => ({ name, count }));
        if (!items.length) {
          addLine({ left: '（空票）', kind: 'total' }, lineIndex++);
        } else {
          for (const item of items) {
            addLine({ left: item.name, right: `× ${item.count}` }, lineIndex++);
          }
          addLine({ left: '合计', right: `${event.total} 件`, kind: 'total' }, lineIndex++);
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

  if (!sawFinal) addLine({ left: '连接结束', kind: 'status' }, lineIndex++);
}

async function startOrder(request) {
  const text = (request || '').trim();
  if (!text) return;
  setChoicesDisabled(true);
  try {
    await runOrder(text);
  } catch (error) {
    showTicket(text);
    lines.innerHTML = '';
    addLine({ left: error.message || '出错了', kind: 'status' }, 0);
  } finally {
    setChoicesDisabled(false);
  }
}

for (const btn of choices) {
  btn.addEventListener('click', () => startOrder(btn.dataset.request || btn.textContent));
}

backBtn.addEventListener('click', showDialog);
