import '@nomiclabs/hardhat-ethers'
import '@nomiclabs/hardhat-waffle'
import '@openzeppelin/hardhat-upgrades'
import '@typechain/hardhat'
import fs from 'fs'
import 'hardhat-abi-exporter'
import 'hardhat-contract-sizer'
import 'hardhat-deploy'
import 'hardhat-deploy-ethers'
import 'hardhat-gas-reporter'
import { HardhatUserConfig } from 'hardhat/types'
import path from 'path'

const NETWORK = process.env.NETWORK || ''
const envFilePath = `.env.${NETWORK}`
require('dotenv').config(
  fs.existsSync(envFilePath) ? { path: `.env.${NETWORK}` } : {}
)

// Prevent to load scripts before compilation and typechain
const SKIP_LOAD = process.env.SKIP_LOAD === 'true'
if (!SKIP_LOAD) {
  const taskPaths = ['deploys', 'migrations', 'miscs']
  taskPaths.forEach((folder) => {
    const tasksPath = path.join(__dirname, 'tasks', folder)
    fs.readdirSync(tasksPath)
      .filter((_path) => _path.includes('.ts'))
      .forEach((task) => {
        require(`${tasksPath}/${task}`)
      })
  })
}

const MNEMONIC = process.env.MNEMONIC || ''
const COINMARKETCAP = process.env.COINMARKETCAP || ''

enum eAstarNetwork {
  astar = 'astar',
  shiden = 'shiden',
  // shibuya = 'shibuya',
}
interface iAstarParamsPerNetwork<T> {
  [eAstarNetwork.astar]: T
  [eAstarNetwork.shiden]: T
  // [eAstarNetwork.shibuya]: T;
}
const GWEI = 1000 * 1000 * 1000
const DEFAULT_GAS_PRICE = 1 * GWEI
const CHAIN_ID: iAstarParamsPerNetwork<number> = {
  [eAstarNetwork.astar]: 592,
  [eAstarNetwork.shiden]: 336,
}
const DEFAULT_GAS: iAstarParamsPerNetwork<number> = {
  [eAstarNetwork.astar]: 15 * GWEI,
  [eAstarNetwork.shiden]: 5 * GWEI,
}
const RPC_URL: iAstarParamsPerNetwork<string> = {
  [eAstarNetwork.astar]: 'https://evm.astar.network',
  [eAstarNetwork.shiden]: 'https://shiden.api.onfinality.io/public',
}

const getNetworkConfig = (network: eAstarNetwork) => {
  const accounts = {
    mnemonic: MNEMONIC,
    path: "m/44'/60'/0'/0",
    initialIndex: 0,
    count: 20,
  }
  return {
    chainId: CHAIN_ID[network],
    url: RPC_URL[network],
    gasPrice: DEFAULT_GAS[network],
    accounts: accounts,
  }
}

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  paths: {
    artifacts: 'build/artifacts',
    cache: 'build/cache',
    deploy: 'src/deploy',
    sources: 'contracts',
  },
  solidity: {
    compilers: [
      {
        version: '0.8.10',
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
        },
      },
    ],
  },
  namedAccounts: {
    deployer: 0,
  },
  typechain: {
    outDir: 'types',
    target: 'ethers-v5',
  },
  networks: {
    hardhat: {
      throwOnTransactionFailures: true,
      throwOnCallFailures: true,
      allowUnlimitedContractSize: true,
      mining: {
        auto: true,
        interval: 0,
      },
      gasPrice: DEFAULT_GAS_PRICE,
      // blockGasLimit: 999_000_000, // use if happened error in test (Error: Transaction reverted and Hardhat couldn't infer the reason. Please report this to help us improve Hardhat.)
    },
    localhost: {
      url: 'http://127.0.0.1:8545',
      gasPrice: 65 * 1000 * 1000 * 1000,
    },
    astar: getNetworkConfig(eAstarNetwork.astar),
    shiden: getNetworkConfig(eAstarNetwork.shiden),
  },
  mocha: {
    timeout: 100000,
  },
  gasReporter: {
    enabled: true,
    currency: 'JPY',
    gasPrice: 20,
    token: 'ETH',
    coinmarketcap: COINMARKETCAP,
    showTimeSpent: true,
    showMethodSig: true,
  },
}
export default config
