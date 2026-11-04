# 公司内部点咖啡 demo（Jev shopping cart 模式）

用 TypeSafe / Jev（systemone）的单一 Choice 循环实现点咖啡。模式来自 Allie（@allietheicon）的 shopping cart 示例：

- 事先不知道用户有几个意图，也不切分句子。
- 状态 = 原始用户请求 + 已选列表（cart）。
- 每轮只问一个 Choice：选项 = 全部菜单项 + `done`。
- 选择非 `done` 的商品时，把它加入 cart，并用同一 state 再问。
- 选择 `done` 时结束。
- 每加入一件，下一轮先对 `last_added` 做 check（noul）。noul 低于阈值（0.45）时，从 cart 移除该商品，并提示菜单范围。

Choice 是硬选择：模型总会选一项。因此 check 用来兜住“选错”的情况，例如用户点了菜单外的抹茶拿铁。

## 目录

```
package.json
src/menu.mjs    固定菜单（故意不含抹茶）
src/jev.mjs     env 加载、Jev 请求、question 构造
src/order.mjs   CLI 与循环
.env.example    配置模板（无真实 key）
```

## 配置 key

三选一，优先级从高到低：进程环境变量 > 项目 `.env` > `~/.config/anti-slop-for-x-jev.env`。

1. 直接导出：

```bash
export JEV_API_KEY="你的 key"
```

2. 使用已有的用户配置（本机已存在该文件）：

```bash
set -a
source ~/.config/anti-slop-for-x-jev.env
set +a
```

3. 复制项目模板：

```bash
cp .env.example .env
# 编辑 .env，填入 JEV_API_KEY
```

`.env` 已在 `.gitignore` 中。不要把真实 key 写进被跟踪的文件。

可选变量：

| 变量 | 默认值 |
|---|---|
| `JEV_BASE_URL` | `https://ai.caph.me/v1` |
| `JEV_PATH` | `/systemone` |
| `JEV_MODEL` | `jev-latest` |

## 运行

```bash
# 直接传入点单
node src/order.mjs "来两杯拿铁再加一个麦芬"

# 交互输入
node src/order.mjs

# 不调 API，只看 payload
node src/order.mjs --dry-run "来两杯燕麦拿铁，再来个麦芬"

# npm script
npm start -- "美式热的，再来热巧克力"
```

`--dry-run` 不要求 key。它打印首轮 choice payload，以及加入一件后的 check payload 示例。

## 输出说明

每轮打印四项：

1. 调用摘要：path、model、cart、last_added。
2. `choice`：模型选中的商品与 confidence。
3. `check`：`noul` 值（或 `score` 归一值）与阈值判断，结果保留或移除。
4. `cart`：当前购物车。

结束时打印按商品聚合的最终订单。

典型输出结构：

```
点单原文：来两杯燕麦拿铁，再来个麦芬
Jev：https://ai.caph.me/v1/systemone model=jev-latest key=已设置

=== 第 1 轮 ===
调用：POST /systemone model=jev-latest state={request:"来两杯燕麦拿铁，再来个麦芬", cart:[], last_added:null}
choice：oat_latte（confidence=0.94）
加入：燕麦拿铁，cart=["燕麦拿铁"]
check：noul=0.98（阈值 0.45）
结果：保留 燕麦拿铁。
cart：["燕麦拿铁"]

...

=== 最终订单 ===
- 燕麦拿铁 × 2
- 麦芬 × 1
合计：3 件
```

菜单外商品（如“那个绿色抹茶拿铁”）有两种结果，均属预期：

- 模型选 `done`：直接提示菜单范围，最终订单为空。
- 模型误选某个菜单项：check 的 noul 低，移除该商品并打印提示。

## 保护

- 最大 12 轮，防止死循环。
- 同一商品连续 2 次被 check 移除时停止。
- Choice 返回未知值时忽略；连续 2 次未知时停止。
- check 未返回 `noul`/`score` 时保留商品，并标记“未确认”。

## 验证范围

`demo-out.txt` 记录三条示例点单的真实运行输出。模型是概率性的，同一输入的 choice 和 noul 可能变化。

已知限制：

- 数量依赖模型逐次选择。例如“两杯”通常选两次同一商品，但不保证。
- check 只判断“菜单内 + 被请求覆盖”，不校验温度、规格等修饰。
- `--dry-run` 只验证 payload 结构，不验证 API 可用性。
