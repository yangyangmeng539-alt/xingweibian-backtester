# stock-supply-chain.v2.seed.json

这是基于 `data\market-graph\stock-relation-raw.seed.json` 做好的 A 股产业链/上下游推断数据。

注意：这是系统推断，不是真实供应商/客户数据库。UI 必须显示“系统推断，可编辑”。

## 文件

- `stock-supply-chain.v2.seed.json`：完整数据
- `stock-supply-chain.v2.min.seed.json`：预览/默认图用的轻量数据，每个层级只保留 top 80 股票
- `user-supply-chain-overrides.json`：用户修改覆盖文件，初始为空

## 统计

- 一级产业链：19
- 二级细分链：120
- 股票数：5513
- 已归入产业链股票：5499
- 股票-产业链归属记录：55582
- 行业数：496
- 概念数（降噪后）：618

## 使用建议

Codex 不要重新推断上下游。直接读取：

```txt
data\market-graph\stock-supply-chain.v2.seed.json
```

默认首页显示：

```js
defaultGraph.primaryChains
defaultGraph.secondaryChainsTop
```

查股票：

```js
stockIndex[code].assignments
```

展开产业链：

```js
chains[].layers.upstream.stocks
chains[].layers.midstream.stocks
chains[].layers.downstream.stocks
chains[].layers.service.stocks
chains[].layers.terminal.stocks
```

用户增删改，不写回 seed，写入：

```txt
data\market-graph\user-supply-chain-overrides.json
```

合并优先级：

```txt
user > inferred > raw
```
