const ticket = document.getElementById('ticket');
const form = document.getElementById('order-form');
const input = document.getElementById('request');
const lines = document.getElementById('ticket-lines');
const resetBtn = document.getElementById('ticket-reset');
const submitBtn = form.querySelector('.ticket__submit');
const dateEl = document.getElementById('ticket-date');

dateEl.textContent = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Singapore',
}).format(new Date());

const EXAMPLES = [
  '来两杯燕麦拿铁，再来个麦芬',
  '美式热的，再来热巧克力',
  '那个绿色抹茶拿铁',
];

if (!input.value) {
  input.placeholder = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)];
}

function clearTicket() {
  lines.innerHTML = '';
  ticket.classList.remove('is-filling', 'is-done', 'is-error');
  form.hidden = false;
  submitBtn.disabled = false;
  submitBtn.textContent = '开票';
  input.focus();
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
  return li;
}

function summarize(cart) {
  const counts = new Map();
  for (const name of cart) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()];
}

async function runOrder(request) {
  ticket.classList.add('is-filling');
  ticket.classList.remove('is-done', 'is-error');
  lines.innerHTML = '';
  addLine({ left: request, kind: 'status' }, 0);
  addLine({ left: '正在开票…', kind: 'status' }, 1);

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
  let lineIndex = 2;
  let sawFinal = false;

  const handleEvent = (event) => {
    switch (event.type) {
      case 'choice': {
        const label = event.matched?.name || event.raw || '（空）';
        const conf =
          typeof event.confidence === 'number' ? event.confidence.toFixed(2) : '';
        addLine(
          {
            left: `选择 ${label}`,
            right: conf,
            kind: 'status',
          },
          lineIndex++,
        );
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
              right:
                event.value == null ? '—' : `${event.kind} ${event.value.toFixed(2)}`,
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
            addLine(
              { left: item.name, right: `× ${item.count}`, kind: '' },
              lineIndex++,
            );
          }
          addLine(
            { left: '合计', right: `${event.total} 件`, kind: 'total' },
            lineIndex++,
          );
        }
        ticket.classList.add('is-done');
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
      const dataLine = chunk
        .split('\n')
        .find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === '{}') continue;
      handleEvent(JSON.parse(payload));
    }
  }

  if (!sawFinal) {
    addLine({ left: '连接结束', kind: 'status' }, lineIndex++);
    ticket.classList.add('is-done');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const request = input.value.trim();
  if (!request) return;
  submitBtn.disabled = true;
  submitBtn.textContent = '开票中';
  try {
    await runOrder(request);
  } catch (error) {
    ticket.classList.add('is-filling', 'is-error');
    addLine({ left: error.message || '出错了', kind: 'status' }, 0);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '开票';
  }
});

resetBtn.addEventListener('click', clearTicket);

/* Slow crossfade on hero atmosphere */
const frames = document.querySelectorAll('[data-crossfade] img');
if (frames.length > 1) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduced) {
    let index = 0;
    setInterval(() => {
      frames[index].classList.remove('is-active');
      index = (index + 1) % frames.length;
      frames[index].classList.add('is-active');
    }, 5600);
  }
}

/* Pause decorative video when tab hidden or reduced motion */
const video = document.querySelector('.showcase__media video');
if (video) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    video.removeAttribute('autoplay');
    video.pause();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
    else if (!reduced) video.play().catch(() => {});
  });
}


/* Section entrances */
const revealEls = document.querySelectorAll('.reveal');
if (revealEls.length && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.18, rootMargin: '0px 0px -8% 0px' },
  );
  revealEls.forEach((el) => io.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add('is-in'));
}

/* Hero sides visible immediately */
document.querySelectorAll('.hero .reveal').forEach((el) => {
  requestAnimationFrame(() => el.classList.add('is-in'));
});
