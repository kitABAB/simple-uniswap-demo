require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// 从 .env 读取私钥与 RPC，缺省时给一个占位值，避免本地编译/测试时报错
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // OpenZeppelin v5.1 的 Bytes.sol 用到了 mcopy 操作码，需要 Cancun EVM
      evmVersion: "cancun",
    },
  },
  networks: {
    // 本地内存链（hardhat node）
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // 以太坊测试网 Sepolia
    sepolia: {
      url: SEPOLIA_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};
