// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SimpleSwap} from "./SimpleSwap.sol";

/// @title SimpleSwapFactory
/// @notice 简化版 Uniswap V2 工厂：为任意两种 ERC-20 代币创建并登记唯一的交易池。
/// @dev    每个代币对只能创建一个池子；代币地址按大小排序后作为 (token0, token1)，
///         保证 (A,B) 与 (B,A) 指向同一个池。仅做教学用途。
contract SimpleSwapFactory {
    // ---------------------------------------------------------------------
    // 状态
    // ---------------------------------------------------------------------

    /// @notice 通过两种代币地址查询对应池子（双向登记）
    mapping(address => mapping(address => address)) public getPair;
    /// @notice 所有已创建的池子地址
    address[] public allPairs;

    // ---------------------------------------------------------------------
    // 事件 / 错误
    // ---------------------------------------------------------------------

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairCount);

    error IdenticalTokens();
    error ZeroAddress();
    error PairExists();

    /// @notice 返回已创建池子的总数
    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice 为 tokenA / tokenB 创建一个新的交易池
    /// @param tokenA 代币 A 地址
    /// @param tokenB 代币 B 地址
    /// @return pair  新池子的地址
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        if (tokenA == tokenB) revert IdenticalTokens();
        // 按地址大小排序，确保唯一性
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairExists();

        SimpleSwap newPair = new SimpleSwap(token0, token1);
        pair = address(newPair);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // 双向登记，方便任意顺序查询
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair, allPairs.length);
    }
}
