import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { task } from 'hardhat/config'
import '@nomiclabs/hardhat-ethers'
import '@openzeppelin/hardhat-upgrades'
import {
  Voter,
  Voter__factory,
  VotingEscrow,
  VotingEscrow__factory,
} from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

type EthereumAddress = `0x${string}`
const SUPPORTED_NETWORK = ['astar', 'shiden'] as const
type SupportedNetwork = typeof SUPPORTED_NETWORK[number]
const LOCKING_TOKEN_ADDRESSES: {
  [key in SupportedNetwork]: EthereumAddress
} = {
  astar: '0xc4335B1b76fA6d52877b3046ECA68F6E708a27dd', // OAL
  shiden: '0xb163716cb6c8b0a56e4f57c394A50F173E34181b', // OAL
}
const LENDING_POOL_ADDRESSES: {
  [key in SupportedNetwork]: EthereumAddress
} = {
  astar: '0xTODO',
  shiden: '0xTODO',
}

task('deploy:all', 'Deploy all contracts')
  .addOptionalParam('lockingToken', 'Token Address to use as Lock input')
  .setAction(
    async (
      { lockingToken }: { lockingToken: string },
      hre: HardhatRuntimeEnvironment
    ) => {
      console.log(`------- [deploy:all] START -------`)
      const { ethers, network, upgrades } = hre
      const deployer = (await ethers.getSigners())[0]
      console.log(`network: ${network.name}`)
      console.log(`deployer: ${deployer.address}`)

      ContractsJsonHelper.reset({ network: network.name })

      const _lockingToken = lockingToken
        ? lockingToken
        : LOCKING_TOKEN_ADDRESSES[network.name as SupportedNetwork]
      ContractsJsonHelper.writeAddress({
        group: 'inputs',
        name: 'lockingToken',
        value: _lockingToken,
        network: network.name,
      })

      const votingEscrow = (await upgrades.deployProxy(
        new VotingEscrow__factory(deployer),
        [_lockingToken]
      )) as VotingEscrow
      await votingEscrow.deployTransaction.wait()
      ContractsJsonHelper.writeAddress({
        group: 'contracts',
        name: 'votingEscrow',
        value: votingEscrow.address,
        network: network.name,
      })

      const voter = (await upgrades.deployProxy(new Voter__factory(deployer), [
        LENDING_POOL_ADDRESSES[network.name as SupportedNetwork],
        votingEscrow.address,
      ])) as Voter
      await voter.deployTransaction.wait()
      ContractsJsonHelper.writeAddress({
        group: 'contracts',
        name: 'voter',
        value: voter.address,
        network: network.name,
      })

      // NOTE: not used in initial release
      // const feeDistributor = (await upgrades.deployProxy(
      //   new FeeDistributor__factory(deployer),
      //   [votingEscrow.address]
      // )) as FeeDistributor
      // await feeDistributor.deployTransaction.wait()
      // ContractsJsonHelper.writeAddress({
      //   group: 'contracts',
      //   name: 'feeDistributor',
      //   value: feeDistributor.address,
      //   network: network.name,
      // })

      console.log(`> VotingEscrow#setVoter`)
      const tx = await votingEscrow.setVoter(voter.address)
      await tx.wait()

      console.log(ContractsJsonHelper.load({ network: network.name }))
      console.log(`------- [deploy:all] END -------`)
    }
  )
