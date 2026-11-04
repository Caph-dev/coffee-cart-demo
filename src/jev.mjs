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

/** Choice：从菜单选下一件加入购物车，或 done。 */
export function buildChoiceQuestion(menu) {
  const criteria = {};
  for (const item of menu) criteria[item.id] = `${item.name}：${item.desc}`;
  criteria.done = '用户已经点完，或剩下的请求无法用菜单满足（例如用户要的商品不在菜单里）';

  return {
    type: 'choice',
    instructions:
      '从菜单里选出用户下一样要加入购物车的商品。用户点了多件或同一件多份时，每轮只选一件，按数量逐次选择。' +
      '只有购物车已经覆盖用户的全部点单，或用户要的商品不在菜单里时，才选 done。' +
      '只按用户原始请求选择，不要加入用户没有点的商品。',
    criteria,
  };
}

/** Check：对 last_added 做 noul 判断。 */
export function buildCheckQuestion() {
  return {
    type: 'noul',
    instructions:
      'last_added 是上一轮刚加入购物车的商品，cart 是当前购物车，request 是用户原始点单。' +
      '判断 last_added 是否明确属于菜单，并且被用户原始请求所覆盖。' +
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
