/**
 * 部署 SimpleSwap AMM 演示环境。
 *
 * 流程：部署工厂 -> 部署两个测试代币 -> 通过工厂创建交易池 ->
 *       添加初始流动性 -> 演示一笔兑换。
 *
 * 本地：  npm run deploy:swap:local   （需先 npm run node）
 * 测试网：npm run deploy:swap:sepolia （需配置 .env，测试网上一般不部署 Mock 代币）
 */
const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("部署账户：", deployer.address);
  console.log("账户余额：", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // ---- 1) 部署工厂 ----
  const Factory = await ethers.getContractFactory("SimpleSwapFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("✅ SimpleSwapFactory 已部署到：", factoryAddress);

  // ---- 2) 部署两个测试代币 ----
  const Mock = await ethers.getContractFactory("MockERC20");
  const initial = ethers.parseEther("1000000");
  const tokenA = await Mock.deploy("Token A", "TKA", 18, initial);
  const tokenB = await Mock.deploy("Token B", "TKB", 18, initial);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  const tokenAAddress = await tokenA.getAddress();
  const tokenBAddress = await tokenB.getAddress();
  console.log("✅ Token A：", tokenAAddress);
  console.log("✅ Token B：", tokenBAddress);

  // ---- 3) 通过工厂创建交易池 ----
  await (await factory.createPair(tokenAAddress, tokenBAddress)).wait();
  const pairAddress = await factory.getPair(tokenAAddress, tokenBAddress);
  console.log("✅ 交易池 SimpleSwap：", pairAddress);

  const pair = await ethers.getContractAt("SimpleSwap", pairAddress);

  // 截止时间：当前时间 + 20 分钟
  const deadline = Math.floor(Date.now() / 1000) + 1200;

  // ---- 4) 添加初始流动性 ----
  const amountA = ethers.parseEther("10000");
  const amountB = ethers.parseEther("40000"); // 初始价格 1 TKA = 4 TKB
  await (await tokenA.approve(pairAddress, amountA)).wait();
  await (await tokenB.approve(pairAddress, amountB)).wait();
  await (await pair.addLiquidity(amountA, amountB, 0, 0, deployer.address, deadline)).wait();
  const lpBalance = await pair.balanceOf(deployer.address);
  console.log("✅ 已添加初始流动性，获得 LP 代币：", ethers.formatEther(lpBalance));

  // ---- 5) 演示一笔兑换：用 100 TKA 换 TKB ----
  const swapIn = ethers.parseEther("100");
  await (await tokenA.approve(pairAddress, swapIn)).wait();
  const before = await tokenB.balanceOf(deployer.address);
  await (await pair.swap(tokenAAddress, swapIn, 0, deployer.address, deadline)).wait();
  const after = await tokenB.balanceOf(deployer.address);
  console.log(`✅ 用 100 TKA 兑换得到 ${ethers.formatEther(after - before)} TKB`);

  const [r0, r1] = await pair.getReserves();
  console.log("当前储备：", ethers.formatEther(r0), "/", ethers.formatEther(r1));

  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("\n开源验证：");
    console.log(`  npx hardhat verify --network ${hre.network.name} ${factoryAddress}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
