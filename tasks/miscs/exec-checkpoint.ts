import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { Voter__factory, VotingEscrow__factory } from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

task('exec:checkpoint-of-voting-escrow', 'exec:checkpoint-of-voting-escrow')
  .addParam('contract', 'VotingEscrow address')
  .addOptionalParam('executor', 'executor address')
  .setAction(
    async (
      { contract, executor }: { contract: string; executor: string },
      hre: HardhatRuntimeEnvironment
    ) => {
      const { ethers, network } = hre

      console.log(`------- [exec:checkpoint-of-voting-escrow] START -------`)
      console.log(`network ... ${network.name}`)
      const _executor =
        (await ethers.getSigner(executor)) || (await ethers.getSigners())[0]
      const instance = VotingEscrow__factory.connect(contract, _executor)

      const check = async () => {
        const epoch = await instance.epoch()
        const p = await instance.pointHistory(epoch.toNumber())
        console.log(`epoch ... ${epoch.toString()}`)
        console.log({
          bias: ethers.utils.formatEther(p.bias),
          slope: ethers.utils.formatEther(p.slope),
          ts: new Date(p.ts.toNumber() * 1000).toISOString(),
          blk: p.blk.toString(),
        })
      }

      console.log(`> before checkpoint`)
      await check()
      const tx = await instance.checkpoint()
      await tx.wait()
      console.log(`> after checkpoint`)
      await check()
      console.log(`------- [exec:checkpoint-of-voting-escrow] FINISHED -------`)
    }
  )

task('exec:checkpoint-of-voter', 'exec:checkpoint-of-voter')
  .addParam('contract', 'VotingEscrow address')
  .addOptionalParam('executor', 'executor address')
  .setAction(
    async (
      { contract, executor }: { contract: string; executor: string },
      hre: HardhatRuntimeEnvironment
    ) => {
      const { ethers, network } = hre

      console.log(`------- [exec:checkpoint-of-voter] START -------`)
      console.log(`network ... ${network.name}`)
      const _executor =
        (await ethers.getSigner(executor)) || (await ethers.getSigners())[0]
      const instance = Voter__factory.connect(contract, _executor)

      const check = async () => {
        const lastTokenTime = await instance.lastTokenTime()
        console.log(
          `lastTokenTime ... ${new Date(
            lastTokenTime.toNumber() * 1000
          ).toISOString()}`
        )
      }

      console.log(`> before checkpoint`)
      await check()
      const tx = await instance.checkpointToken()
      await tx.wait()
      console.log(`> after checkpoint`)
      await check()
      console.log(`------- [exec:checkpoint-of-voter] FINISHED -------`)
    }
  )

// Main
task('exec:checkpoint-of-contracts', 'exec:checkpoint-of-contracts')
  .addOptionalParam('executor', 'executor address')
  .setAction(
    async (
      { executor }: { executor: string },
      hre: HardhatRuntimeEnvironment
    ) => {
      const { ethers, network } = hre
      const _executor = executor ?? (await ethers.getSigners())[0].address
      console.log(`------- [exec:checkpoint-of-contracts] START -------`)
      console.log(`network ... ${network.name}`)

      const { contracts: addresses } = ContractsJsonHelper.load({
        network: network.name,
      })
      await hre.run(`exec:checkpoint-of-voting-escrow`, {
        contract: addresses.votingEscrow,
        executor: _executor,
      })
      await hre.run(`exec:checkpoint-of-voter`, {
        contract: addresses.voter,
        executor: _executor,
      })

      console.log(`------- [exec:checkpoint-of-contracts] FINISHED -------`)
    }
  )
