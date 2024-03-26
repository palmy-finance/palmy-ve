import '@nomiclabs/hardhat-ethers'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { Voter__factory } from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

const SUPPORTED_NETWORK = ['astar', 'shiden', 'localhost'] as const
type SupportedNetwork = typeof SUPPORTED_NETWORK[number]

type EthereumAddress = `0x${string}`
const CONSTANTS: {
  [key in SupportedNetwork]: EthereumAddress
} = {
  astar: '0xTBD',
  shiden: '0xTBD',
  localhost: '0xTBD',
}

task('exec-add-tokens-for-xxx', 'exec-add-tokens-for-xxx').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    console.log(`------- [exec-add-tokens-for-xxx] START -------`)

    if (
      !(SUPPORTED_NETWORK as ReadonlyArray<string>).includes(hre.network.name)
    )
      throw new Error(`Support only ${SUPPORTED_NETWORK} ...`)
    const deployer = (await hre.ethers.getSigners())[0]
    const networkName = hre.network.name as SupportedNetwork
    console.log(`network: ${networkName}`)
    console.log(`deployer: ${deployer.address}`)

    const {
      contracts: { voter },
    } = ContractsJsonHelper.load({
      network: networkName,
    })

    const voterInstance = Voter__factory.connect(voter, deployer)

    // Execute
    console.log(`> Execute`)
    const token = CONSTANTS[networkName]
    console.log(`>> exec .addToken: token = ${token}`)
    const tx = await voterInstance.addToken(token)
    await tx.wait()

    // Confirm
    console.log(`> Confirm`)
    const tokenList = await voterInstance.tokenList()
    console.log(`size = ${tokenList.length}`)
    console.log(`tokenList`)
    console.log(tokenList)
    console.log(`>> About each token`)
    for await (const token of tokenList) {
      const tIndex = await voterInstance.tokenIndex(token)
      console.log({
        tokenIndex: tIndex.toString(),
        token,
      })
    }

    console.log(`------- [exec-add-tokens-for-xxx] END -------`)
  }
)
