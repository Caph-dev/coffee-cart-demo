# Coffee Cart Demo

公司内部点咖啡 demo：用 [Jev](https://ai.caph.me) 把一句口语点单写成订单。先用缩小候选的 **Choice** 找出每件商品（每件最多一次），再问 **数量 Choice**（`one` / `two` / `three` / `invalid`），合法份数写入购物车后做 **last_added check**。份数由 Jev 归类，应用代码不解析数字。

前端是当面演示用的点单页：预设对话框，点选后分成决策过程与小票两栏。

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

**抹茶故意不在菜单里**。菜单外意图应直接 `done`、空购物车（`done` 即 [shopping-cart cookbook](https://docs.typesafe.ai/cookbooks/cart_from_primitives) 的 `nothing_else`）。

## 数量 / Quantity

对齐 cookbook 的两段式，并多一个 `invalid` 桶。Jev classifies the count into `one`, `two`, `three`, or `invalid`. The application only reads that label.

1. **找商品 / Find.** 每轮 Choice 只包含还没出现过的菜单项和 `done`。选中后从下一轮拿掉。没有更多菜单项时选 `done`。
2. **问数量 / Quantity.** 对找到的每一件再发 Choice：`one` / `two` / `three` / `invalid`。criteria 覆盖阿拉伯数字、中文（一杯/一份、两杯、三杯；一/二/两/三）和英文 one/two/three。`invalid` 覆盖小数（0.7）、零、负数（-1）、过大（2^32），以及任何不是 1、2、3 的数量。
3. **写入 / Cart.** `one`/`two`/`three` 按份数重复品名（小票仍是「名称 × N」），然后做 noul check。`invalid` 不加入，过程日志打出「数量非法，无法满足」。
4. **上限 / Cap.** `MAX_ITEM_REQUESTS`（菜单件数 + 1）和 `MAX_REQUESTS`（再乘 3，盖住找商品、数量、check）是硬上限。

手动路径 / Manual path：`npm test`，或配置 key 后 `node src/order.mjs "…"`。`npm run dry-run` 只打印 payload。

| 点单 | 结果 |
| --- | --- |
| 来两杯拿铁 | 拿铁 × 2 |
| 来0.7杯拿铁、来2^32杯拿铁、来-1杯拿铁 | `invalid`，不加入，购物车不堆数量 |
| 来两杯燕麦拿铁，再来个麦芬 | 燕麦拿铁 × 2，麦芬 × 1 |
| 那个绿色抹茶拿铁 | `done`，空购物车 |

## 结构

| 路径 | 作用 |
| --- | --- |
| `src/menu.mjs` | 固定菜单 |
| `src/jev.mjs` | Jev 客户端与 payload |
| `src/cart.mjs` | 缩小候选找商品，再问数量（事件流） |
| `src/order.mjs` | CLI |
| `src/server.mjs` | 静态站点 + `POST /api/order`（SSE） |
| `web/` | 点单页（对话框 → 决策过程 / 小票） |

## API

- `GET /api/health` — 是否配置了 key
- `GET /api/menu` — 菜单 JSON
- `POST /api/order` — body `{"request":"..."}`，响应为 SSE，`data:` 行为 JSON 事件（`choice` / `quantity` / `invalid` / `added` / `check` / `final` …）

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

单页：选一句预设点单 → 左侧流式决策过程，右侧小票只写入已确认的饮品。用来展示 **Jev + 多意图购物车**。静态资源在服务启动时按文件内容哈希，HTML 为 `Cache-Control: no-cache`。

启动：`npm start`，打开对应端口；线上：`https://coffee-demo.caph.me`。
