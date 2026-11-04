#!/usr/bin/env node
/**
 * 公司内部点咖啡 demo：单 Choice 循环 + cart + last_added check。
 *
 * 用法：
 *   node src/order.mjs "来两杯拿铁再加一个麦芬"
 *   node src/order.mjs            # 交互，读 stdin 一行
 *   node src/order.mjs --dry-run  # 不调 API，打印 payload
 */
import readline from 'node:readline/promises';
import { MENU, menuNames, findMenuChoice } from './menu.mjs';
import {
  readConfig,
  callJev,
  buildPayload,
  buildChoiceQuestion,
  buildCheckQuestion,
  readAnswer,
} from './jev.mjs';

const MAX_ROUNDS = 12;
const NOUL_THRESHOLD = 0.45;
const DEFAULT_DRY_RUN_REQUEST = '来两杯拿铁再加一个麦芬';

function parseArgs(argv) {
  const opts = { dryRun: false, help: false, request: '' };
  const words = [];
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else words.push(arg);
  }
  opts.request = words.join(' ').trim();
  return opts;
}

function printHelp() {
  console.log(`用法：
  node src/order.mjs "来两杯拿铁再加一个麦芬"
  node src/order.mjs                交互输入一行
  node src/order.mjs --dry-run      不调 API，打印将发送的 payload

环境变量：
  JEV_BASE_URL   默认 https://ai.caph.me/v1
  JEV_PATH       默认 /systemone
  JEV_MODEL      默认 jev-latest
  JEV_API_KEY    必填（--dry-run 除外）

也会自动加载 ~/.config/anti-slop-for-x-jev.env 和项目 .env。`);
}

async function readRequestFromStdin() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question('请输入点单内容：')).trim();
    } finally {
      rl.close();
    }
  }
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

function formatConfidence(answer) {
  return typeof answer?.confidence === 'number' ? `（confidence=${answer.confidence.toFixed(2)}）` : '';
}

/** check 结果取值：优先 noul，其次 score（0..4 归一到 0..1）。 */
function readCheckValue(answer) {
  if (typeof answer?.noul === 'number') return { value: answer.noul, kind: 'noul' };
  if (typeof answer?.score === 'number') {
    const value = answer.score > 1 ? answer.score / 4 : answer.score;
    return { value, kind: 'score' };
  }
  return { value: null, kind: null };
}

function printDryRun(config, request) {
  const choiceState = { request, cart: [], last_added: null };
  console.log('[dry-run] 不调用 API。首轮 choice payload：');
  console.log(
    JSON.stringify(
      buildPayload(config, choiceState, { next_item: buildChoiceQuestion(MENU) }),
      null,
      2,
    ),
  );

  const sampleState = { request, cart: ['拿铁'], last_added: '拿铁' };
  console.log('\n[dry-run] 加入一件后的 check payload 示例（last_added 示例值：拿铁）：');
  console.log(
    JSON.stringify(
      buildPayload(config, sampleState, { check_last_added: buildCheckQuestion() }),
      null,
      2,
    ),
  );
  console.log(`\n[dry-run] API key：${config.apiKey ? '已设置（不打印值）' : '未设置'}；真实运行需要 JEV_API_KEY。`);
}

function printFinal(cart, stoppedByLimit) {
  if (stoppedByLimit) {
    console.log(`\n注意：达到最大轮数 ${MAX_ROUNDS}，已停止询问。`);
  }
  console.log('\n=== 最终订单 ===');
  if (cart.length === 0) {
    console.log('（空）没有可下单的商品。');
    console.log(`菜单：${menuNames().join('、')}`);
    return;
  }
  const counts = new Map();
  for (const name of cart) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const [name, count] of counts) console.log(`- ${name} × ${count}`);
  console.log(`合计：${cart.length} 件`);
}

async function runOrder(config, request) {
  const cart = [];
  const rejectedCounts = new Map();
  let finished = false;
  let unrecognizedStreak = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n=== 第 ${round} 轮 ===`);

    const choiceState = { request, cart: [...cart], last_added: cart.at(-1) ?? null };
    console.log(
      `调用：POST ${config.path} model=${config.model} state={request:${JSON.stringify(request)}, cart:${JSON.stringify(choiceState.cart)}, last_added:${JSON.stringify(choiceState.last_added)}}`,
    );

    const choiceResponse = await callJev(
      config,
      buildPayload(config, choiceState, { next_item: buildChoiceQuestion(MENU) }),
    );
    const choiceAnswer = readAnswer(choiceResponse, 'next_item');
    const rawChoice = typeof choiceAnswer?.choice === 'string' ? choiceAnswer.choice : '';
    const matched = findMenuChoice(rawChoice);
    console.log(`choice：${rawChoice || '(空)'}${formatConfidence(choiceAnswer)}`);

    if (!matched) {
      unrecognizedStreak += 1;
      console.log(`结果：choice 不在菜单内，本轮忽略。菜单：${menuNames().join('、')}`);
      console.log(`cart：${JSON.stringify(cart)}`);
      if (unrecognizedStreak >= 2) {
        console.log('连续 2 次无法识别 choice，停止询问。');
        finished = true;
        break;
      }
      continue;
    }
    unrecognizedStreak = 0;

    if (matched.id === 'done') {
      if (cart.length === 0) {
        console.log('用户没有从菜单选到任何商品。菜单：' + menuNames().join('、'));
      } else {
        console.log('用户选择 done，结束点单。');
      }
      finished = true;
      break;
    }

    cart.push(matched.name);
    const lastAdded = matched.name;
    console.log(`加入：${matched.name}，cart=${JSON.stringify(cart)}`);

    const checkState = { request, cart: [...cart], last_added: lastAdded };
    const checkResponse = await callJev(
      config,
      buildPayload(config, checkState, { check_last_added: buildCheckQuestion() }),
    );
    const checkAnswer = readAnswer(checkResponse, 'check_last_added');
    const check = readCheckValue(checkAnswer);

    if (check.value === null) {
      console.log(`check：未返回 noul/score，保留 ${lastAdded}（未确认）。`);
      console.log(`cart：${JSON.stringify(cart)}`);
      continue;
    }

    console.log(`check：${check.kind}=${check.value.toFixed(2)}（阈值 ${NOUL_THRESHOLD}）`);
    if (check.value >= NOUL_THRESHOLD) {
      console.log(`结果：保留 ${lastAdded}。`);
      console.log(`cart：${JSON.stringify(cart)}`);
      continue;
    }

    cart.pop();
    const times = (rejectedCounts.get(lastAdded) ?? 0) + 1;
    rejectedCounts.set(lastAdded, times);
    console.log(`结果：移除 ${lastAdded}，置信度低于阈值。`);
    console.log(`提示：「${lastAdded}」不在菜单里，或不是您明确点的。菜单只有：${menuNames().join('、')}。`);
    console.log(`cart：${JSON.stringify(cart)}`);

    if (times >= 2) {
      console.log(`「${lastAdded}」连续 2 次被移除，停止询问。`);
      finished = true;
      break;
    }
  }

  printFinal(cart, !finished);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const config = readConfig();
  const request = opts.request || (opts.dryRun ? DEFAULT_DRY_RUN_REQUEST : await readRequestFromStdin());

  if (!request) {
    console.error('没有收到点单内容。用法：node src/order.mjs "来两杯拿铁再加一个麦芬"');
    process.exitCode = 1;
    return;
  }

  console.log(`点单原文：${request}`);
  console.log(`Jev：${config.baseUrl}${config.path} model=${config.model} key=${config.apiKey ? '已设置' : '未设置'}`);

  if (opts.dryRun) {
    printDryRun(config, request);
    return;
  }

  await runOrder(config, request);
}

main().catch((error) => {
  console.error(`失败：${error?.message || error}`);
  process.exitCode = 1;
});
