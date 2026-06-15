// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockFeeOnTransferERC20
/// @notice 仅用于测试的「收税型」ERC-20：每次转账按固定比例销毁一部分，
///         模拟 fee-on-transfer 代币，用于验证 SimpleSwap 以余额差计量的兼容性。
/// @dev    切勿用于生产环境。
contract MockFeeOnTransferERC20 is ERC20 {
    /// @notice 转账手续费（基点，1% = 100）
    uint256 public immutable feeBps;
    uint256 private constant BPS = 10_000;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        uint256 feeBps_
    ) ERC20(name_, symbol_) {
        require(feeBps_ < BPS, "fee too high");
        feeBps = feeBps_;
        if (initialSupply > 0) {
            _mint(msg.sender, initialSupply);
        }
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev 覆写 OZ v5 的统一转账钩子：普通转账时销毁一部分，铸造/销毁时不收费
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / BPS;
            if (fee > 0) {
                super._update(from, address(0), fee); // 销毁手续费
                value -= fee;
            }
        }
        super._update(from, to, value);
    }
}
