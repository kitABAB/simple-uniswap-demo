// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title SimpleSwap
/// @notice 一个简化版 Uniswap V2 风格的自动做市商（AMM）流动性池。
///         核心是恒定乘积公式 x * y = k：单个池子撮合两种 ERC-20 代币的兑换，
///         流动性提供者（LP）按份额获得本合约铸造的 LP 代币。用于 web3 学习与作品集。
/// @dev    本合约自身即 LP 代币（继承 ERC20）。仅做教学用途，省略了价格预言机、
///         flash swap、工厂多池管理等生产级功能。
///         安全设计：
///         - 所有改变状态的入口都带 `deadline`，防止交易长期滞留 mempool 被抢跑（MEV）。
///         - 加/移除流动性带最小数量保护，兑换带 `amountOutMin`，抵御三明治攻击。
///         - 转账金额一律以「转账前后余额差」为准，兼容收税型（fee-on-transfer）代币。
contract SimpleSwap is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // 不可变配置
    // ---------------------------------------------------------------------

    /// @notice 池中第一种代币
    IERC20 public immutable token0;
    /// @notice 池中第二种代币
    IERC20 public immutable token1;

    /// @notice 永久锁定的最小流动性，防止首个 LP 通过极小流动性操纵价格
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    /// @dev 手续费：0.3%（即保留 99.7% 进入兑换计算）
    uint256 private constant FEE_NUMERATOR = 997;
    uint256 private constant FEE_DENOMINATOR = 1000;

    // ---------------------------------------------------------------------
    // 储备量（缓存的池内余额，用于价格计算）
    // ---------------------------------------------------------------------

    uint256 private reserve0;
    uint256 private reserve1;

    // ---------------------------------------------------------------------
    // 事件
    // ---------------------------------------------------------------------

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event LiquidityRemoved(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swap(
        address indexed sender,
        address indexed to,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out
    );
    event Sync(uint256 reserve0, uint256 reserve1);

    // ---------------------------------------------------------------------
    // 错误
    // ---------------------------------------------------------------------

    error IdenticalTokens();
    error ZeroAddress();
    error Expired();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error SlippageExceeded();
    error InvalidToken();

    /// @dev 截止时间保护：超过 deadline 的交易直接回退
    modifier ensure(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    /// @param _token0 池中第一种代币地址
    /// @param _token1 池中第二种代币地址
    constructor(address _token0, address _token1) ERC20("SimpleSwap LP", "SS-LP") {
        if (_token0 == _token1) revert IdenticalTokens();
        if (_token0 == address(0) || _token1 == address(0)) revert ZeroAddress();
        token0 = IERC20(_token0);
        token1 = IERC20(_token1);
    }

    // ---------------------------------------------------------------------
    // 只读视图
    // ---------------------------------------------------------------------

    /// @notice 返回当前两种代币的储备量
    function getReserves() public view returns (uint256 _reserve0, uint256 _reserve1) {
        return (reserve0, reserve1);
    }

    /// @notice 恒定乘积报价：给定输入数量，计算可兑换出的输出数量（已扣 0.3% 手续费）
    /// @param amountIn      输入代币数量
    /// @param reserveIn     输入代币当前储备
    /// @param reserveOut    输出代币当前储备
    /// @return amountOut    可获得的输出代币数量
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256 amountOut) {
        if (amountIn == 0) revert InsufficientInputAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * FEE_DENOMINATOR + amountInWithFee;
        amountOut = numerator / denominator;
    }

    // ---------------------------------------------------------------------
    // 添加流动性
    // ---------------------------------------------------------------------

    /// @notice 添加流动性并铸造 LP 代币
    /// @dev    调用前需对本合约 approve 两种代币。首次添加时几何平均决定 LP 数量，
    ///         之后按当前储备比例取较小值，避免改变池内价格。
    ///         实际入账数量以转账前后的余额差为准，兼容收税型代币。
    /// @param amount0Desired 希望投入的 token0 数量
    /// @param amount1Desired 希望投入的 token1 数量
    /// @param amount0Min     可接受的最小实际投入 token0（滑点保护）
    /// @param amount1Min     可接受的最小实际投入 token1（滑点保护）
    /// @param to             LP 代币接收地址
    /// @param deadline       交易截止时间戳
    /// @return liquidity     铸造的 LP 代币数量
    function addLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address to,
        uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256 liquidity) {
        if (to == address(0)) revert ZeroAddress();

        uint256 _totalSupply = totalSupply();
        uint256 amount0;
        uint256 amount1;

        if (_totalSupply == 0) {
            // 首次添加：按用户期望全额投入
            amount0 = amount0Desired;
            amount1 = amount1Desired;
        } else {
            // 后续添加：以当前储备比例为准，按较紧约束的一侧投入
            uint256 amount1Optimal = (amount0Desired * reserve1) / reserve0;
            if (amount1Optimal <= amount1Desired) {
                amount0 = amount0Desired;
                amount1 = amount1Optimal;
            } else {
                uint256 amount0Optimal = (amount1Desired * reserve0) / reserve1;
                amount0 = amount0Optimal;
                amount1 = amount1Desired;
            }
        }

        if (amount0 == 0 || amount1 == 0) revert InsufficientInputAmount();
        // 滑点保护：按当前价格折算后的实际投入不得低于用户底线
        if (amount0 < amount0Min || amount1 < amount1Min) revert SlippageExceeded();

        // 以余额差作为真实入账量，兼容收税型代币
        uint256 actual0 = _receive(token0, amount0);
        uint256 actual1 = _receive(token1, amount1);

        if (_totalSupply == 0) {
            // 锁定最小流动性到死亡地址
            liquidity = Math.sqrt(actual0 * actual1) - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min(
                (actual0 * _totalSupply) / reserve0,
                (actual1 * _totalSupply) / reserve1
            );
        }

        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _update();
        emit LiquidityAdded(msg.sender, actual0, actual1, liquidity);
    }

    // ---------------------------------------------------------------------
    // 移除流动性
    // ---------------------------------------------------------------------

    /// @notice 销毁 LP 代币并按份额取回两种代币
    /// @param liquidity  要销毁的 LP 代币数量
    /// @param amount0Min 可接受的最小取回 token0（滑点保护）
    /// @param amount1Min 可接受的最小取回 token1（滑点保护）
    /// @param to         代币接收地址
    /// @param deadline   交易截止时间戳
    /// @return amount0   取回的 token0 数量
    /// @return amount1   取回的 token1 数量
    function removeLiquidity(
        uint256 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        address to,
        uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256 amount0, uint256 amount1) {
        if (to == address(0)) revert ZeroAddress();
        if (liquidity == 0) revert InsufficientLiquidityBurned();

        uint256 _totalSupply = totalSupply();
        uint256 balance0 = token0.balanceOf(address(this));
        uint256 balance1 = token1.balanceOf(address(this));

        // 按 LP 份额比例分配池内真实余额
        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        // 滑点保护
        if (amount0 < amount0Min || amount1 < amount1Min) revert SlippageExceeded();

        _burn(msg.sender, liquidity);

        token0.safeTransfer(to, amount0);
        token1.safeTransfer(to, amount1);

        _update();
        emit LiquidityRemoved(msg.sender, amount0, amount1, liquidity);
    }

    // ---------------------------------------------------------------------
    // 兑换
    // ---------------------------------------------------------------------

    /// @notice 用一种代币兑换另一种代币
    /// @dev    输出按「实际入账数量」计算，因此兼容收税型输入代币。
    /// @param tokenIn      输入代币地址（必须是 token0 或 token1）
    /// @param amountIn     输入数量
    /// @param amountOutMin 可接受的最小输出数量（滑点保护）
    /// @param to           输出代币接收地址
    /// @param deadline     交易截止时间戳
    /// @return amountOut   实际输出数量
    function swap(
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMin,
        address to,
        uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256 amountOut) {
        if (amountIn == 0) revert InsufficientInputAmount();
        if (to == address(0)) revert ZeroAddress();
        if (tokenIn != address(token0) && tokenIn != address(token1)) revert InvalidToken();

        bool isToken0In = tokenIn == address(token0);
        (uint256 reserveIn, uint256 reserveOut) = isToken0In
            ? (reserve0, reserve1)
            : (reserve1, reserve0);

        IERC20 inToken = isToken0In ? token0 : token1;
        IERC20 outToken = isToken0In ? token1 : token0;

        // 先收款，并以余额差作为真实入账量（兼容收税型代币）
        uint256 actualIn = _receive(inToken, amountIn);

        amountOut = getAmountOut(actualIn, reserveIn, reserveOut);
        if (amountOut < amountOutMin) revert InsufficientOutputAmount();

        outToken.safeTransfer(to, amountOut);

        _update();

        if (isToken0In) {
            emit Swap(msg.sender, to, actualIn, 0, 0, amountOut);
        } else {
            emit Swap(msg.sender, to, 0, actualIn, amountOut, 0);
        }
    }

    // ---------------------------------------------------------------------
    // 内部工具
    // ---------------------------------------------------------------------

    /// @dev 从调用者收取 `amount` 个 `token`，返回合约真实入账数量（余额差）。
    ///      对收税型代币而言，返回值会小于 `amount`。
    function _receive(IERC20 token, uint256 amount) private returns (uint256 received) {
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        received = token.balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert InsufficientInputAmount();
    }

    /// @dev 用合约真实余额刷新储备缓存
    function _update() private {
        reserve0 = token0.balanceOf(address(this));
        reserve1 = token1.balanceOf(address(this));
        emit Sync(reserve0, reserve1);
    }
}
