import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
  VotingEscrowV2,
  VotingEscrowV2Rev2,
  VotingEscrowV2Rev2__factory,
  VotingEscrowV2Rev3,
  VotingEscrowV2Rev3__factory,
  VotingEscrowV2__factory,
  VotingEscrow__factory,
} from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

task('upgrade:ve-from-v1-to-v2', 'upgrade:ve-from-v1-to-v2').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    console.log(`------- [upgrade:ve-from-v1-to-v2] START -------`)
    const { ethers, network, upgrades } = hre
    const deployer = (await ethers.getSigners())[0]
    console.log(`network: ${network.name}`)
    console.log(`deployer: ${deployer.address}`)

    const {
      contracts: { votingEscrow },
    } = ContractsJsonHelper.load({
      network: network.name,
    })
    console.log(`votingEscrow address: ${votingEscrow}`)
    console.log(`> check current (V1)`)
    console.log(
      `version: ${await VotingEscrow__factory.connect(
        votingEscrow,
        deployer
      ).version()}`
    )

    console.log(`> upgrade`)
    const veV2 = (await upgrades.upgradeProxy(
      votingEscrow,
      new VotingEscrowV2__factory(deployer),
      { call: { fn: 'initializeV2' } }
    )) as VotingEscrowV2
    await veV2.deployTransaction.wait()
    ContractsJsonHelper.writeAddress({
      group: 'contracts',
      name: 'votingEscrowV2',
      value: veV2.address,
      network: network.name,
    })
    console.log(`>> upgraded`)
    console.log(`> check V2`)
    console.log(`version: ${await veV2.version()}`)
    console.log(`latestLockerId: ${(await veV2.latestLockerId()).toNumber()}`)

    console.log(`------- [upgrade:ve-from-v1-to-v2] END -------`)
  }
)

task('upgrade:ve-from-v2-to-v2rev2', 'upgrade:ve-from-v2-to-v2rev2').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    console.log(`------- [upgrade:ve-from-v2-to-v2rev2] START -------`)
    const { ethers, network, upgrades } = hre
    const deployer = (await ethers.getSigners())[0]
    console.log(`network: ${network.name}`)
    console.log(`deployer: ${deployer.address}`)

    const {
      contracts: { votingEscrow },
    } = ContractsJsonHelper.load({
      network: network.name,
    })
    console.log(`votingEscrow address: ${votingEscrow}`)
    console.log(`> check current (V2)`)
    console.log(
      `version: ${await VotingEscrowV2__factory.connect(
        votingEscrow,
        deployer
      ).version()}`
    )

    console.log(`> upgrade`)
    const veV2Rev2 = (await upgrades.upgradeProxy(
      votingEscrow,
      new VotingEscrowV2Rev2__factory(deployer),
      { call: { fn: 'initializeV2Rev2' } }
    )) as VotingEscrowV2Rev2
    await veV2Rev2.deployTransaction.wait()
    ContractsJsonHelper.writeAddress({
      group: 'contracts',
      name: 'votingEscrowV2Rev2',
      value: veV2Rev2.address,
      network: network.name,
    })
    console.log(`>> upgraded`)
    console.log(`> check V2Rev2`)
    console.log(`version: ${await veV2Rev2.version()}`)
    console.log(
      `latestLockerId: ${(await veV2Rev2.latestLockerId()).toNumber()}`
    )

    console.log(`------- [upgrade:ve-from-v2-to-v2rev2] END -------`)
  }
)

task(
  'upgrade:ve-from-v2rev2-to-v2rev3',
  'upgrade:ve-from-v2rev2-to-v2rev3'
).setAction(async ({}, hre: HardhatRuntimeEnvironment) => {
  console.log(`------- [upgrade:ve-from-v2rev2-to-v2rev3] START -------`)
  const { ethers, network, upgrades } = hre
  const deployer = (await ethers.getSigners())[0]
  console.log(`network: ${network.name}`)
  console.log(`deployer: ${deployer.address}`)

  const {
    contracts: { votingEscrow },
  } = ContractsJsonHelper.load({
    network: network.name,
  })
  console.log(`votingEscrow address: ${votingEscrow}`)
  console.log(`> check current (V2Rev2)`)
  console.log(
    `version: ${await VotingEscrowV2Rev2__factory.connect(
      votingEscrow,
      deployer
    ).version()}`
  )

  console.log(`> upgrade`)
  const veV2Rev3 = (await upgrades.upgradeProxy(
    votingEscrow,
    new VotingEscrowV2Rev3__factory(deployer),
    { call: { fn: 'initializeV2Rev3' } }
  )) as VotingEscrowV2Rev3
  await veV2Rev3.deployTransaction.wait()
  ContractsJsonHelper.writeAddress({
    group: 'contracts',
    name: 'votingEscrowV2Rev3',
    value: veV2Rev3.address,
    network: network.name,
  })
  console.log(`>> upgraded`)
  console.log(`> check V2Rev3`)
  console.log(`version: ${await veV2Rev3.version()}`)
  console.log(`latestLockerId: ${(await veV2Rev3.latestLockerId()).toNumber()}`)

  console.log(`------- [upgrade:ve-from-v2rev2-to-v2rev3] END -------`)
})
