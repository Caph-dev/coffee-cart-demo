#!/usr/bin/env node
/**
 * 公司内部点咖啡 demo：缩小候选找商品，再由数量 Choice（one/two/three/invalid）决定份数。
 *
 * 用法：
 *   node src/order.mjs "来两杯拿铁再加一个麦芬"
 *   node src/order.mjs            # 交互，读 stdin 一行
 *   node src/order.mjs --dry-run  # 不调 API，打印 payload
 */
import readline from 'node:readline/promises';
import { MENU, menuNames } from './menu.mjs';
import {
  readConfig,
  buildPayload,
  buildChoiceQuestion,
  buildOnMenuQuestion,
  buildOneOfEachQuestion,
  buildOrderTemperatureQuestion,
  buildQuantityQuestion,
  buildTemperatureQuestion,
  buildExactQuestion,
  buildCheckQuestion,
} from './jev.mjs';
import { runCart, NOUL_THRESHOLD } from './cart.mjs';

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
  node src/server.mjs               启动前端与 API（默认 :8787）

数量 / quantity：Jev 在 one、two、three、invalid 里选。程序不解析数字。
非法份数（0.7、-1、2^32 等）走 invalid，不写入购物车。
冷热 / temperature：美式、拿铁、燕麦拿铁、卡布奇诺再问 hot、iced、unspecified。
没说、常温或互相矛盾都是 unspecified。菜单默认冰，这类咖啡落单写成冰。热巧克力只卖热的，不再单问。
每样一份（所有的都来一份、全部来一份、one of each）由 Choice 的 all 或 one_of_each noul 展开成菜单每一件各一份。没说整单冷热时，能选冷热的咖啡按默认冰，热巧克力保持原名。程序不解析原文。

环境变量：
  JEV_BASE_URL   默认 https://ai.caph.me/v1
  JEV_PATH       默认 /systemone
  JEV_MODEL      默认 jev-latest
  JEV_API_KEY    必填（--dry-run 除外）
  PORT           前端服务端口，默认 8787

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

function printDryRun(config, request) {
  const latte = MENU.find((item) => item.id === 'latte');
  const choiceState = { request, cart: [], found: [], last_added: null };
  console.log('[dry-run] 不调用 API。首轮 choice payload（剩下的菜单 + all + done，外加 on_menu / one_of_each）：');
  console.log(
    JSON.stringify(
      buildPayload(config, choiceState, {
        next_item: buildChoiceQuestion(MENU, []),
        on_menu: buildOnMenuQuestion(MENU),
        one_of_each: buildOneOfEachQuestion(MENU),
        order_temperature: buildOrderTemperatureQuestion(),
      }),
      null,
      2,
    ),
  );

  const quantityState = { request, cart: [], item: latte.name, found: [latte.name] };
  console.log('\n[dry-run] 找到拿铁后的字段 payload（数量、是不是这一件、冷热）：');
  console.log(
    JSON.stringify(
      buildPayload(config, quantityState, {
        quantity: buildQuantityQuestion(latte),
        exact_item: buildExactQuestion(latte),
        temperature: buildTemperatureQuestion(latte),
      }),
      null,
      2,
    ),
  );

  const sampleState = { request, cart: ['拿铁', '拿铁'], last_added: '拿铁' };
  console.log('\n[dry-run] 合法数量写入后的 check payload 示例（last_added：拿铁）：');
  console.log(
    JSON.stringify(
      buildPayload(config, sampleState, { check_last_added: buildCheckQuestion() }),
      null,
      2,
    ),
  );
  console.log(`\n[dry-run] API key：${config.apiKey ? '已设置（不打印值）' : '未设置'}；真实运行需要 JEV_API_KEY。`);
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

  await runCart(config, request, (event) => {
    switch (event.type) {
      case 'round':
        console.log(`\n=== 第 ${event.round} 轮 ===`);
        break;
      case 'choice': {
        const picked = event.rejected === 'not_on_menu'
          ? '不在菜单'
          : event.matched?.id === 'done'
            ? '没有更多菜单内商品'
            : event.matched?.name || '未识别';
        const choiceConf =
          typeof event.confidence === 'number' ? `（confidence=${event.confidence.toFixed(2)}）` : '';
        console.log(`choice：${picked}${choiceConf}`);
        break;
      }
      case 'unmet':
        console.log(`结果：${event.message || '不在菜单，菜单无法满足'}`);
        break;
      case 'temperature': {
        const labels = { hot: '热', iced: '冰', unspecified: '未说明' };
        const said = labels[event.temperature] || '未说明';
        const appliedMark = labels[event.applied];
        const appliedNote =
          event.applied && event.applied !== event.temperature && appliedMark
            ? `，默认${appliedMark}`
            : '';
        const tempConf =
          typeof event.confidence === 'number' ? `（confidence=${event.confidence.toFixed(2)}）` : '';
        console.log(`温度：${event.item} → ${said}${appliedNote}${tempConf}`);
        break;
      }
      case 'ignored':
        console.log(`结果：choice 不在菜单内，本轮忽略。菜单：${event.menu.join('、')}`);
        console.log(`cart：${JSON.stringify(event.cart)}`);
        break;
      case 'done':
        if (event.empty) {
          console.log(event.message || '不在菜单，菜单无法满足');
          console.log('菜单：' + event.menu.join('、'));
        } else {
          console.log('没有更多菜单内商品，结束点单。');
        }
        break;
      case 'quantity': {
        const qtyConf =
          typeof event.confidence === 'number' ? `（confidence=${event.confidence.toFixed(2)}）` : '';
        console.log(`数量：${event.item} → ${event.quantity || event.raw || '(空)'}${qtyConf}`);
        break;
      }
      case 'invalid':
        console.log(`结果：${event.message || '数量非法，无法满足'}，不加入「${event.item}」。`);
        console.log(`cart：${JSON.stringify(event.cart)}`);
        break;
      case 'added': {
        const qty = Number.isInteger(event.count) ? ` × ${event.count}` : '';
        console.log(`加入：${event.item}${qty}，cart=${JSON.stringify(event.cart)}`);
        break;
      }
      case 'check':
        if (event.value === null) {
          console.log(`check：未返回 noul/score，保留 ${event.item}（未确认）。`);
        } else {
          console.log(`check：${event.kind}=${event.value.toFixed(2)}（阈值 ${NOUL_THRESHOLD}）`);
          if (event.kept) console.log(`结果：保留 ${event.item}。`);
          else {
            console.log(`结果：移除 ${event.item}，置信度低于阈值。`);
            console.log(
              `提示：「${event.item}」不在菜单里，或不是您明确点的。菜单只有：${event.menu.join('、')}。`,
            );
          }
        }
        console.log(`cart：${JSON.stringify(event.cart)}`);
        break;
      case 'stop':
        if (event.reason === 'unrecognized_streak') {
          console.log('连续 2 次无法识别 choice，停止询问。');
        } else if (event.reason === 'reject_streak') {
          console.log(`「${event.item}」连续 2 次被移除，停止询问。`);
        }
        break;
      case 'final': {
        if (event.stoppedByLimit) {
          console.log(`\n注意：达到请求上限，已停止询问。`);
        }
        console.log('\n=== 最终订单 ===');
        if (event.total === 0) {
          console.log(event.message || '没有可下单的商品。');
          console.log(`菜单：${menuNames().join('、')}`);
        } else {
          for (const { name, count } of event.items) console.log(`- ${name} × ${count}`);
          console.log(`合计：${event.total} 件`);
        }
        break;
      }
      default:
        break;
    }
  });
}

main().catch((error) => {
  console.error(`失败：${error?.message || error}`);
  process.exitCode = 1;
});
