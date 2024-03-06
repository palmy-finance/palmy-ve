import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { ethers } from 'ethers'
import { formatEther } from 'ethers/lib/utils'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { Voter__factory, VotingEscrow__factory } from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

// Utils
type Args = {
  address: string
  providerOrSigner: SignerWithAddress | ethers.providers.JsonRpcProvider
}

const checkVotingEscrow = async (args: Args) => {
  console.log(`--- [start] VotingEscrow ---`)
  console.log(`> address ... ${args.address}`)
  const instance = VotingEscrow__factory.connect(
    args.address,
    args.providerOrSigner
  )
  const epoch = (await instance.epoch()).toNumber()

  const check = async (_e: number) => {
    console.log(`# epoch ${_e}`)
    const [pH, slopeChanges] = await Promise.all([
      instance.pointHistory(_e),
      instance.slopeChanges(_e),
    ])
    console.log({
      bias: ethers.utils.formatEther(pH.bias),
      slope: ethers.utils.formatEther(pH.slope),
      ts: new Date(pH.ts.toNumber() * 1000).toISOString(),
      blk: pH.blk.toString(),
    })
    console.log(ethers.utils.formatEther(slopeChanges))
  }

  if (epoch > 0) await check(epoch - 1)
  await check(epoch)
  await check(epoch + 1)
  console.log(`--- [end] VotingEscrow ---`)
}

const checkVoter = async (args: Args) => {
  console.log(`--- [start] Voter ---`)
  console.log(`> address ... ${args.address}`)
  const instance = Voter__factory.connect(args.address, args.providerOrSigner)
  const [currentTerm, tIndex, unitOfTerm, tokenList] = await Promise.all([
    instance.currentTermTimestamp().then((v) => v.toNumber()),
    instance.currentTermIndex().then((v) => v.toNumber()),
    instance.TERM().then((v) => v.toNumber()),
    instance.tokenList(),
  ])
  const lastTokenTime = (await instance.lastTokenTime()).toNumber()
  console.log(`lastTokenTime: ${new Date(lastTokenTime * 1000).toISOString()}`)

  const check = async (ts: number, idx: number, list: string[]) => {
    console.log(`# termIndex: ${idx}`)
    console.log(`## timestamp: ${new Date(ts * 1000).toISOString()}`)
    const tokensPerWeeks = await Promise.all(
      list.map((v) => instance.tokensPerWeek(v, ts))
    )
    for await (const [i, v] of list.entries()) {
      console.log(`## address: ${v}`)
      console.log(formatEther(tokensPerWeeks[i]))
    }
  }

  if (tIndex > 1) await check(currentTerm - unitOfTerm, tIndex - 1, tokenList)
  await check(currentTerm, tIndex, tokenList)
  await check(currentTerm + unitOfTerm, tIndex + 1, tokenList)

  console.log(`--- [end] Voter ---`)
}

task('check:term-status', 'check:term-status').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const {
      network,
      ethers: { provider },
    } = hre
    console.log(`------- [check:term-status] START -------`)
    console.log(`network ... ${network.name}`)
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })
    await checkVotingEscrow({
      address: addresses.votingEscrow,
      providerOrSigner: provider,
    })
    await checkVoter({
      address: addresses.voter,
      providerOrSigner: provider,
    })
    console.log(`------- [check:term-status] END -------`)
  }
)
