import '@nomiclabs/hardhat-ethers'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { VotingEscrow__factory } from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

type EthereumAddress = `0x${string}`
const SUPPORTED_NETWORK = ['astar', 'shiden', 'localhost'] as const
type SupportedNetwork = typeof SUPPORTED_NETWORK[number]

const CONSTANT: {
  [key in SupportedNetwork]: EthereumAddress[]
} = {
  astar: [
    '0x54F5002b5F44E2ef5a98761b6fa97a2eF4437099', //  vesting
    '0xFb5504e1F1F147c7Db1bd9B47dD0465DF3C16310', // vesting
  ],
  shiden: ['0xTBD'],
  localhost: [
    '0x0000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000002',
  ],
}

task('migrate:set-agency-at-launch', 'migrate:set-agency-at-launch').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    console.log(`------- [migrate:set-agency-at-launch] START -------`)

    if (
      !(SUPPORTED_NETWORK as ReadonlyArray<string>).includes(hre.network.name)
    )
      throw new Error(`Support only ${SUPPORTED_NETWORK} ...`)
    const deployer = (await hre.ethers.getSigners())[0]
    const networkName = hre.network.name as SupportedNetwork
    console.log(`network: ${networkName}`)
    console.log(`deployer: ${deployer.address}`)

    const {
      contracts: { votingEscrow },
    } = ContractsJsonHelper.load({
      network: networkName,
    })
    const veInstance = VotingEscrow__factory.connect(votingEscrow, deployer)
    const assignings = CONSTANT[networkName]

    // Pre Confirm
    console.log(
      `deployer: isAgency = ${await veInstance.agencies(deployer.address)}`
    )
    console.log(`[BEFORE about assignings]`)
    for await (const _assigning of assignings) {
      console.log(
        `${_assigning}: isAgency = ${await veInstance.agencies(_assigning)}`
      )
    }
    for await (const _assigning of assignings) {
      // Execute
      console.log(`> Execute: ${_assigning}`)
      const tx = await veInstance.addAgency(_assigning)
      await tx.wait()
      console.log(`>> Executed`)
    }
    console.log(`[AFTER about assignings]`)
    for await (const _assigning of assignings) {
      console.log(
        `${_assigning}: isAgency = ${await veInstance.agencies(_assigning)}`
      )
    }

    console.log(`------- [migrate:set-agency-at-launch] END -------`)
  }
)
