const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const MINIMUM_LIQUIDITY = 1000n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const DEADLINE = 99999999999n; // 远未来时间戳

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

    for (const user of [alice, bob]) {
      await tokenA.mint(user.address, ethers.parseEther("100000"));
      await tokenB.mint(user.address, ethers.parseEther("100000"));
    }

    return { pair, tokenA, tokenB, owner, alice, bob };
  }

  async function addLiquidity(pair, tokenA, tokenB, signer, amountA, amountB) {
    await tokenA.connect(signer).approve(await pair.getAddress(), amountA);
    await tokenB.connect(signer).approve(await pair.getAddress(), amountB);
    return pair
      .connect(signer)
      .addLiquidity(amountA, amountB, 0, 0, signer.address, DEADLINE);
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
      const amountA = ethers.parseEther("500");
      const amountB = ethers.parseEther("4000");
      await tokenA.connect(bob).approve(await pair.getAddress(), amountA);
      await tokenB.connect(bob).approve(await pair.getAddress(), amountB);

      const tokenBBefore = await tokenB.balanceOf(bob.address);
      await pair.connect(bob).addLiquidity(amountA, amountB, 0, 0, bob.address, DEADLINE);
      const tokenBAfter = await tokenB.balanceOf(bob.address);

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

    it("实际投入低于最小值应回退（滑点保护）", async function () {
      const { pair, tokenA, tokenB, alice, bob } = await loadFixture(deployFixture);
      await addLiquidity(pair, tokenA, tokenB, alice, ethers.parseEther("1000"), ethers.parseEther("4000"));

      // bob 期望投入 500 TKA / 4000 TKB，但按 1:4 比例实际只会用到 2000 TKB，
      // 把 amount1Min 设为 4000 则触发滑点保护
      const amountA = ethers.parseEther("500");
      const amountB = ethers.parseEther("4000");
      await tokenA.connect(bob).approve(await pair.getAddress(), amountA);
      await tokenB.connect(bob).approve(await pair.getAddress(), amountB);
      await expect(
        pair.connect(bob).addLiquidity(amountA, amountB, 0, amountB, bob.address, DEADLINE)
      ).to.be.revertedWithCustomError(pair, "SlippageExceeded");
    });

    it("超过 deadline 应回退", async function () {
      const { pair, tokenA, tokenB, alice } = await loadFixture(deployFixture);
      await tokenA.connect(alice).approve(await pair.getAddress(), ethers.parseEther("1000"));
      await tokenB.connect(alice).approve(await pair.getAddress(), ethers.parseEther("4000"));
      await expect(
        pair
          .connect(alice)
          .addLiquidity(ethers.parseEther("1000"), ethers.parseEther("4000"), 0, 0, alice.address, 1)
      ).to.be.revertedWithCustomError(pair, "Expired");
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
      await pair.connect(bob).swap(await tokenA.getAddress(), amountIn, 0, bob.address, DEADLINE);
      const after = await tokenB.balanceOf(bob.address);

      expect(after - before).to.equal(expectedOut);

      const [r0, r1] = await pair.getReserves();
      expect(r0 * r1).to.be.gte(rA * rB);
    });

    it("输出低于最小值应回退（滑点保护）", async function () {
      const { pair, tokenA, tokenB, alice, bob } = await loadFixture(deployFixture);
      await addLiquidity(pair, tokenA, tokenB, alice, ethers.parseEther("10000"), ethers.parseEther("40000"));

      const amountIn = ethers.parseEther("100");
      await tokenA.connect(bob).approve(await pair.getAddress(), amountIn);
      await expect(
        pair
          .connect(bob)
          .swap(await tokenA.getAddress(), amountIn, ethers.parseEther("999999"), bob.address, DEADLINE)
      ).to.be.revertedWithCustomError(pair, "InsufficientOutputAmount");
    });

    it("超过 deadline 应回退", async function () {
      const { pair, tokenA, tokenB, alice, bob } = await loadFixture(deployFixture);
      await addLiquidity(pair, tokenA, tokenB, alice, ethers.parseEther("10000"), ethers.parseEther("40000"));
      const amountIn = ethers.parseEther("100");
      await tokenA.connect(bob).approve(await pair.getAddress(), amountIn);
      await expect(
        pair.connect(bob).swap(await tokenA.getAddress(), amountIn, 0, bob.address, 1)
      ).to.be.revertedWithCustomError(pair, "Expired");
    });

    it("非池内代币应回退", async function () {
      const { pair, alice, bob, tokenA, tokenB } = await loadFixture(deployFixture);
      await addLiquidity(pair, tokenA, tokenB, alice, ethers.parseEther("10000"), ethers.parseEther("40000"));

      const Mock = await ethers.getContractFactory("MockERC20");
      const other = await Mock.deploy("Other", "OTH", 18, SUPPLY);
      await other.waitForDeployment();
      await expect(
        pair.connect(bob).swap(await other.getAddress(), ethers.parseEther("1"), 0, bob.address, DEADLINE)
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

      await pair.connect(alice).removeLiquidity(lp, 0, 0, alice.address, DEADLINE);

      const aAfter = await tokenA.balanceOf(alice.address);
      const bAfter = await tokenB.balanceOf(alice.address);

      expect(aAfter - aBefore).to.be.gt(0);
      expect(bAfter - bBefore).to.be.gt(0);
      expect(aAfter - aBefore).to.be.lt(amountA);
      expect(await pair.balanceOf(alice.address)).to.equal(0);
    });

    it("取回低于最小值应回退（滑点保护）", async function () {
      const { pair, tokenA, tokenB, alice } = await loadFixture(deployFixture);
      await addLiquidity(pair, tokenA, tokenB, alice, ethers.parseEther("1000"), ethers.parseEther("4000"));
      const lp = await pair.balanceOf(alice.address);
      await expect(
        pair.connect(alice).removeLiquidity(lp, ethers.parseEther("999999"), 0, alice.address, DEADLINE)
      ).to.be.revertedWithCustomError(pair, "SlippageExceeded");
    });

    it("销毁 0 应回退", async function () {
      const { pair, tokenA, tokenB, alice } = await loadFixture(deployFixture);
      await addLiquidity(pair, tokenA, tokenB, alice, ethers.parseEther("1000"), ethers.parseEther("4000"));
      await expect(
        pair.connect(alice).removeLiquidity(0n, 0, 0, alice.address, DEADLINE)
      ).to.be.revertedWithCustomError(pair, "InsufficientLiquidityBurned");
    });
  });

  describe("收税型代币（fee-on-transfer）兼容", function () {
    async function feeFixture() {
      const [owner, alice, bob] = await ethers.getSigners();
      const Fee = await ethers.getContractFactory("MockFeeOnTransferERC20");
      const Mock = await ethers.getContractFactory("MockERC20");
      const feeTok = await Fee.deploy("Fee Token", "FEE", SUPPLY, 100n); // 1% 转账税
      const normal = await Mock.deploy("Normal", "NRM", 18, SUPPLY);
      await feeTok.waitForDeployment();
      await normal.waitForDeployment();

      const Swap = await ethers.getContractFactory("SimpleSwap");
      const pair = await Swap.deploy(await feeTok.getAddress(), await normal.getAddress());
      await pair.waitForDeployment();

      await feeTok.mint(bob.address, ethers.parseEther("10000"));
      await normal.mint(bob.address, ethers.parseEther("10000"));

      return { pair, feeTok, normal, owner, alice, bob };
    }

    it("以余额差计量：加流动性储备与真实到账一致", async function () {
      const { pair, feeTok, normal, owner } = await feeFixture();
      const amountFee = ethers.parseEther("1000");
      const amountNorm = ethers.parseEther("1000");
      await feeTok.approve(await pair.getAddress(), amountFee);
      await normal.approve(await pair.getAddress(), amountNorm);
      await pair.addLiquidity(amountFee, amountNorm, 0, 0, owner.address, DEADLINE);

      // 储备应等于合约真实余额（收税后 feeTok 到账 990）
      const [r0, r1] = await pair.getReserves();
      expect(r0).to.equal(await feeTok.balanceOf(await pair.getAddress()));
      expect(r1).to.equal(await normal.balanceOf(await pair.getAddress()));
      expect(r0).to.equal(ethers.parseEther("990")); // 1000 - 1%
    });

    it("用收税型代币兑换：按实际到账量计价，k 不被破坏", async function () {
      const { pair, feeTok, normal, owner, bob } = await feeFixture();
      await feeTok.approve(await pair.getAddress(), ethers.parseEther("1000"));
      await normal.approve(await pair.getAddress(), ethers.parseEther("1000"));
      await pair.addLiquidity(ethers.parseEther("1000"), ethers.parseEther("1000"), 0, 0, owner.address, DEADLINE);

      const [r0Before, r1Before] = await pair.getReserves();
      const kBefore = r0Before * r1Before;

      const amountIn = ethers.parseEther("100");
      await feeTok.connect(bob).approve(await pair.getAddress(), amountIn);
      const normBefore = await normal.balanceOf(bob.address);
      // feeTok 是 token0：实际到账 = 99，应据此计价且不回退
      await pair.connect(bob).swap(await feeTok.getAddress(), amountIn, 0, bob.address, DEADLINE);
      const normAfter = await normal.balanceOf(bob.address);

      expect(normAfter - normBefore).to.be.gt(0);

      const [r0After, r1After] = await pair.getReserves();
      expect(r0After * r1After).to.be.gte(kBefore);
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
