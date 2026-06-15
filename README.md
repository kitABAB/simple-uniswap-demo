# Simple Uniswap Demo 🦄

一个**简化版 Uniswap V2 风格的自动做市商（AMM）训练项目**，用于学习 Solidity / DeFi 开发，并作为求职作品集。

核心是恒定乘积公式 **`x * y = k`**：单个池子撮合两种 ERC-20 代币的兑换，流动性提供者（LP）按份额获得 LP 代币。

技术栈：**Solidity 0.8.28 + Hardhat + OpenZeppelin v5**。

---

## ✨ 功能特性

| 功能 | 说明 |
| --- | --- |
| 恒定乘积做市 | `x * y = k`，自动定价，无需订单簿 |
| 添加 / 移除流动性 | 按储备比例铸造 / 销毁 LP 代币 |
| LP 代币 | 池子自身即 **ERC-20** LP 凭证（可拆分、可转让） |
| 代币兑换 | 0.3% 手续费，带 `amountOutMin` 滑点保护 |
| 最小流动性锁定 | 首个 LP 锁定 `MINIMUM_LIQUIDITY`，防止价格操纵 |
| 工厂模式 | `SimpleSwapFactory` 为任意代币对创建并登记唯一池子 |
| **截止时间保护** | 所有写入函数带 `deadline`，防止交易滞留 mempool 被抢跑（MEV） |
| **滑点保护** | 加/移除流动性带最小数量参数，抵御三明治攻击 |
| **收税代币兼容** | 转账金额以「余额差」计量，兼容 fee-on-transfer 代币 |
| 安全 | `SafeERC20` + `ReentrancyGuard` 防重入 |
| Gas 优化 | 使用自定义 `error` 代替 `require` 字符串 |

> ⚠️ 仅用于教学，省略了价格预言机、flash swap、路由多跳兑换等生产级功能。

---

## 📁 项目结构

```
uniswap/
├── contracts/
│   ├── SimpleSwap.sol          # 恒定乘积 AMM 池子（自身即 LP 代币）
│   ├── SimpleSwapFactory.sol   # 工厂：为代币对创建并登记池子
│   └── mocks/
│       └── MockERC20.sol       # 测试用可自由铸造的 ERC-20 代币
├── scripts/
│   └── deploySwap.js           # 部署演示：工厂→建池→加流动性→兑换
├── test/
│   └── SimpleSwap.test.js      # 池子 + 工厂完整测试（14 用例）
├── hardhat.config.js           # Hardhat 配置
├── .env.example                # 环境变量模板
└── package.json
```

---

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 编译合约

```bash
npm run compile
```

### 3. 运行测试

```bash
npm test
```

### 4. 本地部署演示

开一个终端启动本地链：

```bash
npm run node
```

另开一个终端部署（自动部署工厂、两个测试代币、建池、加流动性并演示一笔兑换）：

```bash
npm run deploy:swap:local
```

---

## 📖 合约核心方法速查

### SimpleSwap（池子）

| 方法 | 说明 |
| --- | --- |
| `addLiquidity(amount0Desired, amount1Desired, amount0Min, amount1Min, to, deadline)` | 注入两种代币，铸造 LP 代币（带滑点 + 截止时间保护） |
| `removeLiquidity(liquidity, amount0Min, amount1Min, to, deadline)` | 销毁 LP 代币，按份额取回两种代币（带滑点 + 截止时间保护） |
| `swap(tokenIn, amountIn, amountOutMin, to, deadline)` | 兑换（0.3% 手续费 + 滑点 + 截止时间保护） |
| `getAmountOut(amountIn, reserveIn, reserveOut)` | 恒定乘积报价（纯函数） |
| `getReserves()` | 查询两种代币当前储备 |

### SimpleSwapFactory（工厂）

| 方法 | 说明 |
| --- | --- |
| `createPair(tokenA, tokenB)` | 为代币对创建唯一池子 |
| `getPair(tokenA, tokenB)` | 查询代币对对应的池子地址（双向登记） |
| `allPairsLength()` | 已创建池子总数 |

---

## 🧠 学习要点（面试常问）

- **恒定乘积做市原理？** `x * y = k`，兑换前后乘积不减小，手续费留在池内使 `k` 增长。
- **`getAmountOut` 为什么这么算？** 输入扣 0.3% 手续费后代入 `k` 不变约束，推导出输出数量。
- **为什么要锁定 `MINIMUM_LIQUIDITY`？** 防止首个 LP 用极小流动性把单份 LP 价格抬到很高，攻击后来者。
- **LP 代币为什么是 ERC-20？** 流动性份额需要可拆分、可累加、可转让，天然适合同质化代币。
- **Uniswap V2 vs V3 的 LP？** V2 是 ERC-20；V3 因每个头寸有独立价格区间，改用 ERC-721（NFT）。
- **重入防护？** 所有外部转账函数加 `nonReentrant`，并用 `SafeERC20` 兼容非标准 ERC-20。

---

## 📜 License

MIT
