# Coffee Cart Demo

公司内部点咖啡 demo：用 [Jev](https://ai.caph.me) 把一句口语点单写成订单。先用缩小候选的 **Choice** 找出每件商品（每件最多一次），选项里另有 `all`（剩下的每一件各来一份）和 `done`。同一请求里用 **noul** 确认还有没有按本名点到的菜单项，并用 `one_of_each` noul 确认是不是「每样一份」。再问这件是不是本人、**数量 Choice**（`one` / `two` / `three` / `invalid`），咖啡再问 **冷热 Choice**（`hot` / `iced` / `unspecified`）。合法份数写入购物车后做 **last_added check**。`all` / `one_of_each` 不走本名检查（那些问会把没点名的整单拒掉），直接把剩下的在售各写一份。份数和冷热由 Jev 归类，应用代码不解析原文。

前端是当面演示用的点单页：左侧列出全部在售（咖啡、热巧克力、点心），右侧是预设和自己写的一句，点选后分成决策过程与小票两栏。

## 快速开始

```bash
# 配置 key（任选其一）
cp .env.example .env   # 写入 JEV_API_KEY=...
# 或使用 ~/.config/anti-slop-for-x-jev.env

# 命令行点单
node src/order.mjs "来两杯燕麦拿铁，再来个麦芬"

# 前端 + API（默认 http://127.0.0.1:8787）
npm start
# PORT=8080 npm start
```

演示站：`https://coffee-demo.caph.me`（部署后）。

## 菜单

美式、拿铁、燕麦拿铁、卡布奇诺、热巧克力、麦芬、司康。

**抹茶故意不在菜单里**。抹茶拿铁、绿色抹茶拿铁、香草拿铁都不是拿铁，不能收成菜单里最像的那一杯。菜单外或只是相近名称时，购物车保持为空，过程和小票写明「不在菜单，菜单无法满足」（`done` 即 [shopping-cart cookbook](https://docs.typesafe.ai/cookbooks/cart_from_primitives) 的 `nothing_else`）。

## 数量 / Quantity

对齐 cookbook 的两段式，并多一个 `invalid` 桶。Jev classifies the count into `one`, `two`, `three`, or `invalid`. The application only reads that label.

1. **找商品 / Find.** 每轮 Choice 只包含还没出现过的菜单项、`all` 和 `done`。同一请求的 `on_menu` noul 问：剩下的菜单里还有没有按本名点到的。相近名称（抹茶拿铁、香草拿铁）不算。这一问为否时，不采用 Choice 里那个最像的选项。选中后从下一轮拿掉。没有更多菜单项时选 `done`。
2. **每样一份 / One of each.** 「所有的都来一份」「全部来一份」「每样一份」、one of each、all of them、everything 由 Jev 选 `all`，或由同一请求的 `one_of_each` noul 确认。确认后，剩下的在售各写 **一份**（美式、拿铁、燕麦拿铁、卡布奇诺、热巧克力、麦芬、司康）。同一请求的 `order_temperature` 若是 hot / iced，只标在可以选冷热的咖啡上。没说则那些咖啡按默认冰写成「· 冰」，事件里仍是 `unspecified`。热巧克力保持原名。同一句里夹了菜单外的商品（宫保鸡丁、抹茶）时仍展开在售菜单，不加那件菜单外的。只有抹茶、宫保鸡丁时不选 `all`，购物车仍为空。`所有的都来两份` 不是各一份。程序不扫原句，只认 Jev 的 `all` 或过阈值的 `one_of_each`。
3. **问数量 / Quantity.** 对找到的每一件再发 Choice：`one` / `two` / `three` / `invalid`。同一请求还有 `exact_item`：是不是这一件本身。criteria 覆盖阿拉伯数字、中文（一杯/一份、两杯、三杯；一/二/两/三）和英文 one/two/three。`invalid` 覆盖小数（0.7）、零、负数（-1）、过大（2^32），以及任何不是 1、2、3 的数量。
4. **冷热 / Temperature.** 美式、拿铁、燕麦拿铁、卡布奇诺再问 `hot` / `iced` / `unspecified`。criteria 覆盖热 / 冰 / 常温未说，以及 hot / iced。没说、常温、互相矛盾都是 `unspecified`，Choice 不替客人改成 iced。菜单上这四杯标「默认冰」；落单时 `unspecified` 写成「燕麦拿铁 · 冰」。客人说了热或冰，小票照说的写。热巧克力只卖热的，不再单问，也不套默认冰，小票就写「热巧克力」。
5. **写入 / Cart.** `exact_item` 为否时不写入。`one`/`two`/`three` 按份数重复品名（小票仍是「名称 × N」），然后做 noul check。`invalid` 不加入，过程日志打出「数量非法，无法满足」。check 不把只共享名字的饮品留下。
6. **上限 / Cap.** `MAX_ITEM_REQUESTS`（菜单件数 + 1）和 `MAX_REQUESTS`（再乘 3，盖住找商品、字段、check）是硬上限。

手动路径 / Manual path：`npm test`，或配置 key 后 `node src/order.mjs "…"`。`npm run dry-run` 只打印 payload。

| 点单 | 结果 |
| --- | --- |
| 来两杯拿铁 | 拿铁 · 冰 × 2（没说冷热，按默认冰） |
| 一杯燕麦拿铁 | 燕麦拿铁 · 冰 × 1 |
| 两杯热拿铁 | 拿铁 · 热 × 2 |
| 一杯冰美式 | 美式 · 冰 × 1 |
| 来0.7杯拿铁、来2^32杯拿铁、来-1杯拿铁 | `invalid`，不加入，购物车不堆数量 |
| 来两杯燕麦拿铁，再来个麦芬 | 燕麦拿铁 · 冰 × 2，麦芬 × 1 |
| 那个绿色抹茶拿铁、抹茶拿铁、香草拿铁、宫保鸡丁 | 不收成菜单项；空购物车，并写明不在菜单 |
| 所有的都来一份、全部来一份、one of each | 四杯咖啡 · 冰 × 1，热巧克力、麦芬、司康各 × 1 |
| 所有的都来一份，再来份宫保鸡丁 | 同上，不加宫保鸡丁 |

## 结构

| 路径 | 作用 |
| --- | --- |
| `src/menu.mjs` | 固定菜单 |
| `src/jev.mjs` | Jev 客户端与 payload |
| `src/cart.mjs` | 缩小候选找商品，再问数量（事件流） |
| `src/order.mjs` | CLI |
| `src/server.mjs` | 静态站点 + `POST /api/order`（SSE） |
| `web/` | 点单页（对话框 → 决策过程 / 小票） |

## 一次时延记录

页末有 2026-11-08 15:56–15:57（新加坡时间）的静态结果。代码固定 `a28b202306300924a46a2fdf1ecdf61b568ae627`。数字在 `web/data/luna-20261108.json`。页面上的毫秒保留一位小数，按这个文件四舍五入。打开页面不会再次请求模型。

两边都走用户网关 `https://ai.caph.me/v1`。Jev 用现有 `runCart`，一单多次请求，这次返回 `jev-1.14.0`。GPT-6 Luna 走 `/chat/completions`，一次整单，`json_object` 加本地 `EXTRACTION_SCHEMA` 校验，再走店规。这次不是 strict JSON schema，也不是厂商直连。5 个样本各 5 次，双方各 25 单，AB/BA 交替，并发 1，各 1 次预热不计分，零重试。计时含完整响应、解析、校验和店规处理，不是首 token。

这组样本的中位是 Jev 897.6 ms、Luna 1683.7 ms，双方 25/25。46.7% 是两个中位数的相对差，(1683.659 − 897.608) / 1683.659，不是每单降幅。两商品样本 Luna 中位 1956.0 ms，Jev 2091.9 ms，范围重叠。请求写了 `reasoning_effort: none`，返回没有 `reasoning_tokens` 字段；缺字段不是 0，也不能证明思考已关闭。Jev 的 25 单没有 `total_tokens`，缺失同样不是 0。更早的 DeepSeek 记录不是同一时段，不放进这次排名。

## API

- `GET /api/health` — 是否配置了 key
- `GET /api/menu` — 菜单 JSON
- `POST /api/order` — body `{"request":"..."}`，响应为 SSE，`data:` 行为 JSON 事件（`choice` / `quantity` / `temperature` / `unmet` / `invalid` / `added` / `check` / `final` …）

## 环境变量

| 变量 | 默认 |
| --- | --- |
| `JEV_BASE_URL` | `https://ai.caph.me/v1` |
| `JEV_PATH` | `/systemone` |
| `JEV_MODEL` | `jev-latest` |
| `JEV_API_KEY` | （必填） |
| `PORT` | `8787` |
| `HOST` | `0.0.0.0` |

## 前端

单页：左侧列出全部在售——咖啡（美式、拿铁、燕麦拿铁、卡布奇诺，各标「默认冰」）、其他饮品（热巧克力）、点心（麦芬、司康）。右侧选预设或自己写一句。点单后，左侧流式决策过程，右侧小票只写入已确认的。客人说了热或冰，品名后写「· 热」或「· 冰」；咖啡没说冷热时按默认冰写「· 冰」，过程里仍记下 Choice 是未说明。菜单无法满足时，过程和小票都写明「不在菜单，菜单无法满足」。用来展示 **Jev + 多意图购物车**。静态资源在服务启动时按文件内容哈希，HTML 为 `Cache-Control: no-cache`。

启动：`npm start`，打开对应端口；线上：`https://coffee-demo.caph.me`。
