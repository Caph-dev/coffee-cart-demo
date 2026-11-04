/**
 * Jev（TypeSafe / system one）最小客户端。
 * 只依赖 node:fetch，无第三方包。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG_ENV_FILE = path.join(os.homedir(), '.config', 'anti-slop-for-x-jev.env');
const PROJECT_ENV_FILE = path.join(PROJECT_ROOT, '.env');

/** 解析 KEY=VALUE 文件。支持 export 前缀、注释、单/双引号。 */
function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * 依次加载 ~/.config/anti-slop-for-x-jev.env 和项目 .env。
 * 进程环境变量优先级最高；项目 .env 覆盖用户配置。
 */
export function loadEnv() {
  const merged = { ...parseEnvFile(CONFIG_ENV_FILE), ...parseEnvFile(PROJECT_ENV_FILE) };
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

function normalizePath(value) {
  const withSlash = value.startsWith('/') ? value : `/${value}`;
  return withSlash.replace(/\/+$/, '') || '/';
}

export function readConfig() {
  loadEnv();
  return {
    baseUrl: (process.env.JEV_BASE_URL || 'https://ai.caph.me/v1').replace(/\/+$/, ''),
    path: normalizePath(process.env.JEV_PATH || '/systemone'),
    model: process.env.JEV_MODEL || 'jev-latest',
    apiKey: process.env.JEV_API_KEY || '',
  };
}

function itemCriteria(item) {
  const not = Array.isArray(item.not) && item.not.length ? item.not.join('、') : '';
  return {
    is: `${item.name}：${item.desc}`,
    only: `只在用户点的就是「${item.name}」这一件时选。热、冰、杯数都不另算一件。`,
    not: not
      ? `这些不是这一件，不要选：${not}。名字里夹了「${item.name}」但不是同一件的，也不要选。`
      : `名字只是相近，或另一种商品里夹了「${item.name}」这几个字，都不要选。`,
  };
}

/**
 * Choice：在还没计入的菜单项里选下一件，或 done。
 * done 即 shopping-cart cookbook 的 nothing_else：没有更多按本名点到的菜单项。
 * 数量和冷热不在这一问里拆开。相近名称不要收成最像的菜单项。
 */
export function buildChoiceQuestion(menu, foundNames = []) {
  const criteria = {};
  for (const item of menu) criteria[item.id] = itemCriteria(item);
  const already = foundNames.length ? foundNames.join('、') : '还没有';
  criteria.done = {
    means: '除了已经计入的商品，没有其它按本名点到的菜单项。',
    use_when: '用户已经点完，或剩下的是菜单外、中餐，或只是相近名称。',
    do_not: '不要用最像的菜单项顶替。抹茶拿铁、绿色抹茶拿铁、香草拿铁都不是拿铁。宫保鸡丁不在菜单里。',
  };

  return {
    type: 'choice',
    instructions:
      `这是咖啡店点单。已经计入的商品：${already}。` +
      '在剩下的菜单项里，用户还用本名点到了哪一件？提到多件时，选最先用本名点到的那一件。' +
      '每一件最多出现一次；这一问不要按数量或冷热拆开。' +
      '名字只是相近、或另一种饮品里夹了菜单上的字（抹茶拿铁不是拿铁，香草拿铁不是拿铁，燕麦拿铁不是拿铁），不要选最像的那件；还有别的本名就选那件，否则选 done。' +
      '只按用户原始请求选择，不要加入用户没有点的商品。',
    criteria,
  };
}

/**
 * 与找商品同一请求的 noul：剩下的菜单里还有没有按本名点到的。
 * Choice 必须落在某个选项上，相近名称容易被收成拿铁；这一问为否时，调用方不采用那个选项。
 */
export function buildOnMenuQuestion(menu) {
  const names = menu.map((item) => item.name).join('、') || '没有';
  return {
    type: 'noul',
    instructions: {
      question: '在还没计入的菜单项里，用户有没有至少一件是按本名点到的？',
      remaining: names,
      rule: '只沾了名字的一部分不算点到。不要把菜单外的饮品算成最像的那一件。',
    },
    criteria: {
      true: {
        means: '剩下的菜单里，至少一件被用户按本名点到。同一句里另外夹了菜单外的商品，也不改变这一点。',
        examples: [
          '来一杯拿铁',
          '冰美式',
          '两杯燕麦拿铁，再来个麦芬',
          '来一杯拿铁，再来份宫保鸡丁',
          '抹茶拿铁，再来个麦芬：麦芬是菜单本名，所以 yes；不要把抹茶拿铁当成拿铁',
        ],
      },
      false: {
        means: '剩下的请求里没有菜单项的本名。菜单外饮品、中餐、只是相近的名字，都算没有。',
        examples: ['那个绿色抹茶拿铁', '抹茶拿铁', '香草拿铁', '来一份宫保鸡丁，再来碗炒饭', '来杯咖啡'],
        not: '抹茶拿铁、绿色抹茶拿铁、香草拿铁都不是拿铁。不要因为里面有「拿铁」两个字就答 yes。',
      },
    },
  };
}

/**
 * Choice：某一件已经找到的商品要几份。
 * 只允许 one / two / three / invalid。份数归类交给 Jev，调用方不解析数字。
 */
export function buildQuantityQuestion(item) {
  const name = item?.name || '这一项';
  return {
    type: 'choice',
    instructions:
      `只判断用户原始点单里「${name}」要几份。不要把别的商品算进来，不要做算术，也不要四舍五入。` +
      '没写数量，或只是点了一杯、一份、一个，选 one。' +
      '只有恰好 1、2 或 3 才选 one、two、three。零、负数、小数、四份及以上都选 invalid。',
    criteria: {
      one:
        '这一项是 1 份。覆盖阿拉伯数字 1；中文一、一杯、一份、一个；英文 one。没写数量也算一份。',
      two:
        '这一项是 2 份。覆盖阿拉伯数字 2；中文二、两、两杯、两份、两个；英文 two。',
      three:
        '这一项是 3 份。覆盖阿拉伯数字 3；中文三、三杯、三份、三个；英文 three。',
      invalid:
        '这一项的数量不是恰好 1、2 或 3。包括小数或分数（0.7）、零（0、零）、负数（-1）、很大的数（2^32），' +
        '以及任何进制或数词系统里不属于 1、2、3 的数量（例如四、4、four、100）。不要四舍五入到 one、two 或 three。',
    },
  };
}

/**
 * Choice：这一杯咖啡的冷热。没说、常温、或互相矛盾，都是 unspecified，不要猜。
 */
export function buildTemperatureQuestion(item) {
  const name = item?.name || '这一杯';
  return {
    type: 'choice',
    instructions:
      `只判断用户对「${name}」说的冷热。没说、说常温，或又热又冰互相矛盾，都选 unspecified。不要替客人猜热或冰。`,
    criteria: {
      hot: '要热的。覆盖：热、热的、加热、温热、hot。不是冰。',
      iced: '要冰的。覆盖：冰、冰的、加冰、去冰、iced。不是热。',
      unspecified: '没提冷热，或说了常温、室温，或同时要热又要冰。选这个，不要发明热或冰。',
    },
  };
}

/**
 * Noul：刚选中的菜单项是不是用户点的那一件本身。
 * 为否时不写入购物车。热、冰和杯数不影响这一问。
 */
export function buildExactQuestion(item) {
  const name = item?.name || '这一项';
  const notList = Array.isArray(item?.not) && item.not.length ? item.not.join('、') : '';
  return {
    type: 'noul',
    instructions: {
      question: `用户有没有点「${name}」这一件本身？`,
      rule: '必须是这件商品的本名。热、冰、常温没说、以及杯数，都不改变是不是这一件。不要用相近名称顶上。',
    },
    criteria: {
      true: `用户点的就是「${name}」。例如：来一杯${name}、热${name}、冰${name}、两杯${name}。`,
      false: notList
        ? `用户没点「${name}」本身。这些都不是：${notList}。只是名字里带了这几个字，也不算。`
        : `用户没点「${name}」本身，或点的是菜单外、另一种只沾了名字的商品。`,
    },
  };
}

/** Check：对 last_added 做 noul 判断。相近名称共享的字不算点到了这件。 */
export function buildCheckQuestion() {
  return {
    type: 'noul',
    instructions: {
      question: 'last_added 是不是用户点的那一件菜单商品本身？',
      state: 'last_added 是刚写入的商品名，temperature 是已经分开判断的冷热，cart 是当前购物车，request 是用户原始点单。',
      ignore: '数量和冷热已经单独决定。不要因为份数、热、冰或没说冷热而否定这件。',
    },
    criteria: {
      true: {
        means: '用户点的就是 last_added 这一件。',
        examples: ['来一杯拿铁 → 拿铁', '冰美式 → 美式', '两杯燕麦拿铁 → 燕麦拿铁', '热卡布奇诺 → 卡布奇诺'],
      },
      false: {
        means: '用户没点这件，或点的是另一种只沾了名字的饮品。',
        examples: ['那个绿色抹茶拿铁 → 拿铁', '抹茶拿铁 → 拿铁', '香草拿铁 → 拿铁', '宫保鸡丁 → 任何菜单项'],
        not: '共享「拿铁」两个字不算点了拿铁。不要把相近名称留在购物车里。',
      },
    },
  };
}

export function buildPayload(config, state, questions) {
  return { model: config.model, state, questions };
}

/** 发送一次 Jev 请求，返回解析后的 JSON。失败时抛出带状态码的错误。 */
export async function callJev(config, payload, { timeoutMs = 30_000 } = {}) {
  if (!config.apiKey) {
    throw new Error(
      '缺少 JEV_API_KEY。请设置环境变量，或写入 ~/.config/anti-slop-for-x-jev.env / 项目 .env。',
    );
  }

  const url = `${config.baseUrl}${config.path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Jev 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`Jev 请求失败（HTTP ${response.status}）：${text.slice(0, 500)}`);
  }
  return json;
}

/** 取 answers[key]；不存在时返回 null。 */
export function readAnswer(response, key) {
  const answer = response?.answers?.[key];
  return answer && typeof answer === 'object' ? answer : null;
}
