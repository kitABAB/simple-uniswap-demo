const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const MINIMUM_LIQUIDITY = 1000n;
const DEAD = "0x000000000000000000000000000000000000dEaD";

// 与合约一致的报价公式（0.3% 手续费）
function getAmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  return numerator / denominator;
}

// 整数平方根（与 OZ Math.sqrt 一致：向下取整）
function sqrt(value) {
  if (value < 0n) throw new Error("negative");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

describe("SimpleSwap", function () {
  const SUPPLY = ethers.parseEther("1000000");

  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    let tokenA = await Mock.deploy("Token A", "TKA", 18, SUPPLY);
    let tokenB = await Mock.deploy("Token B", "TKB", 18, SUPPLY);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    // 让 token0 < token1，方便对照储备顺序
    if ((await tokenA.getAddress()).toLowerCase() > (await tokenB.getAddress()).toLowerCase()) {
      [tokenA, tokenB] = [tokenB, tokenA];
    }

    const Swap = await ethers.getContractFactory("SimpleSwap");
    const pair = await Swap.deploy(await tokenA.getAddress(), await tokenB.getAddress());
    await pair.waitForDeployment();

    // 给 alice、bob 分发一些代币
    for (const user of [alice, bob]) {
      await tokenA.mint(user.address, ethers.parseEther("100000"));
      await tokenB.mint(user.address, ethers.parseEther("100000"));
    }

    return { pair, tokenA, tokenB, owner, alice, bob };
  }

  async function addLiquidity(pair, tokenA, tokenB, signer, amountA, amountB) {
    await tokenA.connect(signer).approve(await pair.getAddress(), amountA);
    await tokenB.connect(signer).approve(await pair.getAddress(), amountB);
    return pair.connect(signer).addLiquidity(amountA, amountB, signer.address);
  }

  describe("部署", function () {
    it("初始化 token 与储备正确", async function () {
      const { pair, tokenA, tokenB } = await loadFixture(deployFixture);
      expect(await pair.token0()).to.equal(await tokenA.getAddress());
      expect(await pair.token1()).to.equal(await tokenB.getAddress());
      const [r0, r1] = await pair.getReserves();
      expect(r0).to.equal(0);
      expect(r1).to.equal(0);
      expect(await pair.totalSupply()).to.equal(0);
    });

    it("相同代币应回退", async function () {
      const { tokenA } = await loadFixture(deployFixture);
      const Swap = await ethers.getContractFactory("SimpleSwap");
      await expect(
        Swap.deploy(await tokenA.getAddress(), await tokenA.getAddress())
      ).to.be.revertedWithCustomError(Swap, "IdenticalTokens");
    });

    it("零地址应回退", async function () {
      const { tokenA } = await loadFixture(deployFixture);
      const Swap = await ethers.getContractFactory("SimpleSwap");
      await expect(
        Swap.deploy(await tokenA.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(Swap, "ZeroAddress");
    });
  });

  describe("添加流动性", function () {
    it("首次添加按几何平均铸造 LP，并锁定最小流动性", async function () {
      const { pair, tokenA, tokenB, alice } = await loadFixture(deployFixture);
      const amountA = ethers.parseEther("1000");
      const amountB = ethers.parseEther("4000");

      const expectedLiquidity = sqrt(amountA * amountB) - MINIMUM_LIQUIDITY;
      await expect(addLiquidity(pair, tokenA, tokenB, alice, amountA, amountB))
        .to.emit(pair, "LiquidityAdded")
        .withArgs(alice.address, amountA, amountB, expectedLiquidity);

      expect(await pair.balanceOf(alice.address)).to.equal(expectedLiquidity);
      expect(await pair.balanceOf(DEAD)).to.equal(MINIMUM_LIQUIDITY);
      expect(await pair.totalSupply()).to.equal(expectedLiquidity + MINIMUM_LIQUIDITY);

      const [r0, r1] = await pair.getReserves();
      expect(r0).to.equal(amountA);
      expect(r1).to.equal(amountB);
    });

    it("后续添加按比例铸造，多余的一侧自动收紧", async function () {
      const { pair, tokenA, tokenB, alice, bob } = await loadFixture(deployFixture);
      await addLiquidity(pair, tokenA, tokenB, alice, ethers.parseEther("1000"), ethers.parseEther("4000"));

      const totalBefore = await pair.totalSupply();
      // bob 提供 500/4000，比例上限受 token0 约束 -> 实际只用 500/2000
      const amountA = ethers.parseEther("500");
      const amountB = ethers.parseEther("4000");
      await tokenA.connect(bob).approve(await pair.getAddress(), amountA);
      await tokenB.connect(bob).approve(await pair.getAddress(), amountB);

      const tokenBBefore = await tokenB.balanceOf(bob.address);
      await pair.connect(bob).addLiquidity(amountA, amountB, bob.address);
      const tokenBAfter = await tokenB.balanceOf(bob.address);

      // 只消耗了 2000 TKB（保持 1:4 比例）
      expect(tokenBBefore - tokenBAfter).to.equal(ethers.parseEther("2000"));

      const expectedLp = (amountA * totalBefore) / ethers.parseEther("1000");
      expect(await pair.balanceOf(bob.address)).to.equal(expectedLp);
    });

    it("投入数量为 0 应回退", async function () {
      const { pair, tokenA, tokenB, alice } = await loadFixture(deployFixture);
      await expect(
        addLiquidity(pair, tokenA, tokenB, alice, 0n, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(pair, "InsufficientInputAmount");
    });
  });

  describe("兑换", function () {
    it("用 token0 兑换 token1，输出符合恒定乘积公式", async function () {
      const { pair, tokenA, tokenB, alice, bob } = await loadFixture(deployFixture);
      const rA = ethers.parseEther("10000");
      const rB = ethers.parseEther("40000");
      await addLiquidity(pair, tokenA, tokenB, alice, rA, rB);

      const amountIn = ethers.parseEther("100");
      const expectedOut = getAmountOut(amountIn, rA, rB);

      await tokenA.connect(bob).approve(await pair.getAddress(), amountIn);
      const before = await tokenB.balanceOf(bob.address);
      await pair.connect(bob).swap(await tokenA.getAddress(), amountIn, 0, bob.address);
      const after = await tokenB.balanceOf(bob.address);

      expect(after - before).to.equal(expectedOut);

      // 兑换后 k 不减小（手续费留在池内）
      const [r0, r1] = await pair.getReserves();
      expect(r0 * r1).to.be.gte(rA * rB);
    });

    it("输出低于最小值应回退（滑点保护）", async function () {
      const { pair, tokenA, tokenB, alice, bob } = await loadFixture(deployFixture);
      await addLiquidity(pair, tokenA, tokenB, alice, ethers.parseEther("10000"), ethers.parseEther("40000"));

      const amountIn = ethers.parseEther("100");
      await tokenA.connect(bob).approve(await pair.getAddress(), amountIn);
      await expect(
        pair.connect(bob).swap(await tokenA.getAddress(), amountIn, ethers.parseEther("999999"), bob.address)
      ).to.be.revertedWithCustomError(pair, "InsufficientOutputAmount");
    });

    it("非池内代币应回退", async function () {
      const { pair, alice, bob, tokenA, tokenB } = await loadFixture(deployFixture);
      await addLiquidity(pair, tokenA, tokenB, alice, ethers.parseEther("10000"), ethers.parseEther("40000"));

      const Mock = await ethers.getContractFactory("MockERC20");
      const other = await Mock.deploy("Other", "OTH", 18, SUPPLY);
      await other.waitForDeployment();
      await expect(
        pair.connect(bob).swap(await other.getAddress(), ethers.parseEther("1"), 0, bob.address)
      ).to.be.revertedWithCustomError(pair, "InvalidToken");
    });
  });

  describe("移除流动性", function () {
    it("销毁 LP 后按份额取回两种代币", async function () {
      const { pair, tokenA, tokenB, alice } = await loadFixture(deployFixture);
      const amountA = ethers.parseEther("1000");
      const amountB = ethers.parseEther("4000");
      await addLiquidity(pair, tokenA, tokenB, alice, amountA, amountB);

      const lp = await pair.balanceOf(alice.address);
      const aBefore = await tokenA.balanceOf(alice.address);
      const bBefore = await tokenB.balanceOf(alice.address);

      await pair.connect(alice).removeLiquidity(lp, alice.address);

      const aAfter = await tokenA.balanceOf(alice.address);
      const bAfter = await tokenB.balanceOf(alice.address);

      // 因 MINIMUM_LIQUIDITY 永久锁定，取回略少于全部投入
      expect(aAfter - aBefore).to.be.gt(0);
      expect(bAfter - bBefore).to.be.gt(0);
      expect(aAfter - aBefore).to.be.lt(amountA);
      expect(await pair.balanceOf(alice.address)).to.equal(0);
    });

    it("销毁 0 应回退", async function () {
      const { pair, tokenA, tokenB, alice } = await loadFixture(deployFixture);
      await addLiquidity(pair, tokenA, tokenB, alice, ethers.parseEther("1000"), ethers.parseEther("4000"));
      await expect(
        pair.connect(alice).removeLiquidity(0n, alice.address)
      ).to.be.revertedWithCustomError(pair, "InsufficientLiquidityBurned");
    });
  });

  describe("工厂 SimpleSwapFactory", function () {
    async function factoryFixture() {
      const { tokenA, tokenB } = await loadFixture(deployFixture);
      const Factory = await ethers.getContractFactory("SimpleSwapFactory");
      const factory = await Factory.deploy();
      await factory.waitForDeployment();
      return { factory, tokenA, tokenB };
    }

    it("创建池子并双向登记", async function () {
      const { factory, tokenA, tokenB } = await factoryFixture();
      const a = await tokenA.getAddress();
      const b = await tokenB.getAddress();

      await expect(factory.createPair(a, b)).to.emit(factory, "PairCreated");

      const pair = await factory.getPair(a, b);
      expect(pair).to.not.equal(ethers.ZeroAddress);
      expect(await factory.getPair(b, a)).to.equal(pair);
      expect(await factory.allPairsLength()).to.equal(1);
    });

    it("重复创建应回退", async function () {
      const { factory, tokenA, tokenB } = await factoryFixture();
      const a = await tokenA.getAddress();
      const b = await tokenB.getAddress();
      await factory.createPair(a, b);
      await expect(factory.createPair(a, b)).to.be.revertedWithCustomError(factory, "PairExists");
    });

    it("相同代币应回退", async function () {
      const { factory, tokenA } = await factoryFixture();
      const a = await tokenA.getAddress();
      await expect(factory.createPair(a, a)).to.be.revertedWithCustomError(factory, "IdenticalTokens");
    });
  });
});
