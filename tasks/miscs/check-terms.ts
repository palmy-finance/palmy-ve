import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { Voter__factory } from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

task('check:terms', 'check:terms').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const {
      network,
      ethers: { provider },
    } = hre

    console.log(`------- [check:terms] START -------`)
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })
    const instance = Voter__factory.connect(addresses.voter, provider)

    const currentTermIndex = await instance
      .currentTermIndex()
      .then((v) => v.toNumber())
    const currentTermTimestamp = await instance
      .currentTermTimestamp()
      .then((v) => v.toNumber())

    console.log(`> CURRENT`)
    console.log(`termIndex: ${currentTermIndex}`)
    console.log(
      `timestamp: ${new Date(currentTermTimestamp * 1000).toISOString()}`
    )
    console.log(``)
    for (let i = 0; i < currentTermIndex + 4; i++) {
      const ts = await instance
        .termTimestampByIndex(i)
        .then((v) => v.toNumber())
      console.log(
        `${i.toString().padStart(2, ' ')}: ${new Date(
          ts * 1000
        ).toISOString()} (${ts})`
      )
    }
    console.log(`------- [check:terms] END -------`)
  }
)
