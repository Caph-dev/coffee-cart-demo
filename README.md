# Coffee Cart Demo

公司内部点咖啡 demo：用 [Jev](https://ai.caph.me) 的 **Choice 循环 + shopping cart + last_added check**，把一句口语点单写成订单。

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

**抹茶故意不在菜单里**，用来测 check 是否会把菜单外商品踢掉（常见结果是直接 `done`、空购物车）。

## 结构

| 路径 | 作用 |
| --- | --- |
| `src/menu.mjs` | 固定菜单 |
| `src/jev.mjs` | Jev 客户端与 payload |
| `src/cart.mjs` | Choice 循环（事件流） |
| `src/order.mjs` | CLI |
| `src/server.mjs` | 静态站点 + `POST /api/order`（SSE） |
| `web/` | 点单页（对话框 → 决策过程 / 小票） |

## API

- `GET /api/health` — 是否配置了 key
- `GET /api/menu` — 菜单 JSON
- `POST /api/order` — body `{"request":"..."}`，响应为 SSE，`data:` 行为 JSON 事件（`choice` / `added` / `check` / `final` …）

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
