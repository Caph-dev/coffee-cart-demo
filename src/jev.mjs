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

/**
 * Choice：在还没计入的菜单项里选下一件，或 done。
 * done 即 shopping-cart cookbook 的 nothing_else：没有更多菜单内商品。
 * 数量不在这一问里拆开。
 */
export function buildChoiceQuestion(menu, foundNames = []) {
  const criteria = {};
  for (const item of menu) criteria[item.id] = `${item.name}：${item.desc}`;
  const already = foundNames.length ? foundNames.join('、') : '还没有';
  criteria.done =
    '除了已经计入的商品，点单里没有其它菜单内商品。用户已经点完，或剩下的请求无法用菜单满足（例如要的商品不在菜单里）。';

  return {
    type: 'choice',
    instructions:
      `这是咖啡店点单。已经计入的商品：${already}。` +
      '在剩下的菜单项里，用户还提到了哪一件？提到多件时，选最先提到的那一件。' +
      '每一件最多出现一次；这一问不要按数量拆成多件，数量会单独询问。' +
      '没有更多菜单内商品时选 done。只按用户原始请求选择，不要加入用户没有点的商品。',
    criteria,
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

/** Check：对 last_added 做 noul 判断。 */
export function buildCheckQuestion() {
  return {
    type: 'noul',
    instructions:
      'last_added 是上一轮刚加入购物车的商品，cart 是当前购物车，request 是用户原始点单。' +
      '判断 last_added 是否明确属于菜单，并且被用户原始请求所覆盖。' +
      '数量已经由单独的问题决定；这里只判断这件商品该不该留下，不要因为份数本身否定它。' +
      '用户请求只提到菜单外商品时，任何菜单项都不算被覆盖。',
    criteria: {
      true: 'last_added 在菜单内，而且用户原始请求明确点到了它；数量或统称覆盖也算',
      false: 'last_added 不在菜单内，或者用户原始请求没有点它',
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
