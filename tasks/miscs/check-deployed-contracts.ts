import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { ethers } from 'ethers'
import { formatEther } from 'ethers/lib/utils'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
  Token__factory,
  Voter__factory,
  VotingEscrowV2__factory,
} from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

// Utils
type Args = {
  address: string
  providerOrSigner: SignerWithAddress | ethers.providers.JsonRpcProvider
}

const checkVotingEscrow = async (args: Args) => {
  console.log(`--- [start] VotingEscrowV2 ---`)
  console.log(`> address ... ${args.address}`)
  const _instance = await VotingEscrowV2__factory.connect(
    args.address,
    args.providerOrSigner
  )
  const targets = [
    { label: 'name', fn: _instance.name },
    { label: 'symbol', fn: _instance.symbol },
    { label: 'version', fn: _instance.version },
    { label: 'decimals', fn: _instance.decimals },
    { label: 'token', fn: _instance.token },
    { label: '_term', fn: _instance._term },
    { label: 'supply', fn: _instance.supply },
    { label: 'totalSupply', fn: _instance.totalSupply },
    { label: 'epoch', fn: _instance.epoch },
    { label: 'voter', fn: _instance.voter },
    { label: 'latestLockerId', fn: _instance.latestLockerId },
  ]
  for (const _v of targets) console.log(`${_v.label} ... ${await _v.fn()}`)
  const epoch = (await _instance.epoch()).toNumber()
  const pointHistory = await _instance.pointHistory(epoch)
  console.log(`pointHistory(${epoch}):`)
  console.log({
    bias: ethers.utils.formatEther(pointHistory.bias),
    slope: ethers.utils.formatEther(pointHistory.slope),
    ts: pointHistory.ts.toNumber(),
    tsDate: new Date(pointHistory.ts.toNumber() * 1000).toISOString(),
    blk: pointHistory.blk.toString(),
  })
  console.log(`--- [end] VotingEscrow ---`)
}

const checkVoter = async (args: Args) => {
  console.log(`--- [start] Voter ---`)
  console.log(`> address ... ${args.address}`)
  const _instance = await Voter__factory.connect(
    args.address,
    args.providerOrSigner
  )
  const targets = [
    { label: '_ve', fn: _instance._ve },
    { label: 'lastTokenTime', fn: _instance.lastTokenTime },
    { label: 'startTime', fn: _instance.startTime },
    { label: 'minter', fn: _instance.minter },
    { label: '_term', fn: _instance._term },
    { label: 'maxVoteDuration', fn: _instance.maxVoteDuration },
  ]
  for (const _v of targets) console.log(`${_v.label} ... ${await _v.fn()}`)
  const tokenList = await _instance.tokenList()
  console.log(`tokenList ... ${tokenList}`)
  console.log(`tokenList (length) ... ${tokenList.length}`)
  for (let i = 0; i < tokenList.length; i++) {
    console.log(`> index: ${i}`)
    console.log(`tokens(${i}) ... ${await _instance.tokens(i)}`)
    console.log(`totalWeight(${i}) ... ${await _instance.totalWeight(i)}`)
    console.log(
      `tokenLastBalance(${i}) ... ${await _instance.tokenLastBalance(i)}`
    )
  }
  console.log(`--- [end] Voter ---`)
}

// Main
task('check:deployed-contracts', 'check:deployed-contracts').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const {
      network,
      ethers: { provider },
    } = hre
    console.log(`------- [check:deployed-contract] START -------`)
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

    // NOTE: not used in initial release
    // await checkFeeDistributor({
    //   address: addresses.feeDistributor,
    //   providerOrSigner: provider,
    // })
    console.log(`------- [check:deployed-contract] END -------`)
  }
)

// For checking oal balance of eoa
const TARGET_EOAS: string[] = []
task(
  'check:balance-of-locking-token',
  'check:balance-of-locking-token'
).setAction(async ({}, hre: HardhatRuntimeEnvironment) => {
  const {
    network,
    ethers: { provider },
  } = hre
  console.log(`------- [check:balance-of-locking-token] START -------`)
  console.log(`network ... ${network.name}`)

  const {
    inputs: { lockingToken },
  } = ContractsJsonHelper.load({
    network: network.name,
  })

  const oal = Token__factory.connect(lockingToken, provider)

  for await (const eoa of TARGET_EOAS) {
    const balanceOf = await oal.balanceOf(eoa)
    console.log(`address: ${eoa}`)
    console.log(`> balanceOf: ${formatEther(balanceOf)}`)
  }

  console.log(`------- [check:balance-of-locking-token] END -------`)
})
