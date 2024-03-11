import { ContractTransaction } from 'ethers/lib/ethers'
import { formatEther, formatUnits, parseEther } from 'ethers/lib/utils'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
  ERC20__factory,
  LToken__factory,
  Voter__factory,
  VotingEscrow__factory,
} from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

type EthereumAddress = `0x${string}`
const HOUR = 60 * 60 // in minute
const DAY = HOUR * 24
const WEEK = 7 * DAY
const MONTH = 4 * WEEK
const YEAR = DAY * 365

const OAL: { [key in string]: EthereumAddress } = {
  astar: '0xTBD',
  shiden: '0xb163716cb6c8b0a56e4f57c394A50F173E34181b',
}
const EOA: EthereumAddress = '0xTBD'

const PARAMS_CREATE_LOCK = {
  amount: parseEther('1000'),
  duration: 2 * YEAR,
}
task('temp:exec:create-lock', 'temp:exec:create-lock').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })
    let tx: ContractTransaction
    const signer = await ethers.getSigner(EOA)
    const oal = ERC20__factory.connect(OAL[network.name], signer)
    const votingEscrow = VotingEscrow__factory.connect(
      addresses.votingEscrow,
      signer
    )

    console.log(`------- [temp:exec:create-lock] START -------`)
    console.log(`network ... ${network.name}`)
    tx = await oal.approve(addresses.votingEscrow, PARAMS_CREATE_LOCK.amount)
    await tx.wait()
    tx = await votingEscrow.createLock(PARAMS_CREATE_LOCK.amount, 2 * YEAR)
    await tx.wait()
    console.log(`------- [temp:exec:create-lock] END -------`)
  }
)

const PARAMS_INCREASE_AMOUNT = {
  amount: parseEther('1000'),
}
task('temp:exec:increase-amount', 'temp:exec:increase-amount').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })
    let tx: ContractTransaction
    const signer = await ethers.getSigner(EOA)
    const oal = ERC20__factory.connect(OAL[network.name], signer)
    const votingEscrow = VotingEscrow__factory.connect(
      addresses.votingEscrow,
      signer
    )

    console.log(`------- [temp:exec:increase-amount] START -------`)
    console.log(`network ... ${network.name}`)
    tx = await oal.approve(
      addresses.votingEscrow,
      PARAMS_INCREASE_AMOUNT.amount
    )
    await tx.wait()
    tx = await votingEscrow.increaseAmount(PARAMS_INCREASE_AMOUNT.amount)
    await tx.wait()
    console.log(`------- [temp:exec:increase-amount] END -------`)
  }
)

const PARAMS_INCREASE_UNLOCK_TIME = {
  duration: 2 * YEAR,
}
task(
  'temp:exec:increase-unlock-time',
  'temp:exec:increase-unlock-time'
).setAction(async ({}, hre: HardhatRuntimeEnvironment) => {
  const { ethers, network } = hre
  const { contracts: addresses } = ContractsJsonHelper.load({
    network: network.name,
  })
  let tx: ContractTransaction
  const signer = await ethers.getSigner(EOA)
  const votingEscrow = VotingEscrow__factory.connect(
    addresses.votingEscrow,
    signer
  )

  console.log(`------- [temp:exec:increase-unlock-time] START -------`)
  console.log(`network ... ${network.name}`)
  tx = await votingEscrow.increaseUnlockTime(
    PARAMS_INCREASE_UNLOCK_TIME.duration
  )
  await tx.wait()
  console.log(`------- [temp:exec:increase-unlock-time] END -------`)
})

const TERM = 0.5 * HOUR
const PARAMS_VOTE = {
  duration: TERM * 12,
  weights: [
    0, // WASTR
    0, // WSDN
    0, // WETH
    0, // WBTC
    1, // USDT
    1, // USDC
    0, // OAL
    0, // BUSD
    0, // DAI
    0, // MATIC
    0, // BNB
    0, // DOT
  ],
}
task('temp:exec:vote', 'temp:exec:vote').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })
    let tx: ContractTransaction
    const signer = await ethers.getSigner(EOA)
    const voter = Voter__factory.connect(addresses.voter, signer)

    console.log(`------- [temp:exec:vote] START -------`)
    console.log(`network ... ${network.name}`)
    const currentTimestamp = (
      await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
    ).timestamp
    const currentTerm = Math.floor(currentTimestamp / TERM) * TERM
    tx = await voter.voteUntil(
      PARAMS_VOTE.weights,
      currentTerm + PARAMS_VOTE.duration
    )
    await tx.wait()
    console.log(`------- [temp:exec:vote] END -------`)
  }
)

task('temp:exec:poke', 'temp:exec:poke').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })
    let tx: ContractTransaction
    const signer = await ethers.getSigner(EOA)
    const voter = Voter__factory.connect(addresses.voter, signer)

    console.log(`------- [temp:exec:poke] START -------`)
    console.log(`network ... ${network.name}`)
    tx = await voter.poke()
    await tx.wait()
    console.log(`------- [temp:exec:poke] END -------`)
  }
)

task(
  'temp:check:ve:balance-of-locker-id',
  'temp:check:ve:balance-of-locker-id'
).setAction(async ({}, hre: HardhatRuntimeEnvironment) => {
  const { ethers, network } = hre
  const { contracts: addresses } = ContractsJsonHelper.load({
    network: network.name,
  })
  const signer = await ethers.getSigner(EOA)
  const votingEscrow = VotingEscrow__factory.connect(
    addresses.votingEscrow,
    signer
  )

  const blockNumber = await ethers.provider.getBlockNumber()
  const lockerId = await votingEscrow.ownerToId(EOA)
  const [balanceOfLockerId, balanceOfLockerIdAt] = await Promise.all([
    votingEscrow.balanceOfLockerId(lockerId),
    votingEscrow.balanceOfLockerIdAt(lockerId, blockNumber),
  ])
  console.log(formatEther(balanceOfLockerId))
  console.log(formatEther(balanceOfLockerIdAt))
})

task('temp:check:ve:user-point', 'temp:check:ve:user-point').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })
    const signer = await ethers.getSigner(EOA)
    const votingEscrow = VotingEscrow__factory.connect(
      addresses.votingEscrow,
      signer
    )

    const lockerId = await votingEscrow.ownerToId(EOA)
    const userPointEpoch = (
      await votingEscrow.userPointEpoch(lockerId)
    ).toNumber()
    console.log(userPointEpoch)

    const getUserPointHistory = async (epoch: number) => {
      const ph = await votingEscrow.userPointHistory(lockerId, epoch)
      return {
        bias: formatEther(ph.bias),
        slope: formatEther(ph.slope),
        ts: ph.ts.toNumber(),
        tsDate: new Date(ph.ts.toNumber() * 1000).toISOString(),
        blk: ph.blk.toNumber(),
      }
    }
    const getLocked = async () => {
      const locked = await votingEscrow.locked(lockerId)
      return {
        amount: formatEther(locked.amount),
        end: locked.end.toNumber(),
        endDate: new Date(locked.end.toNumber() * 1000).toISOString(),
      }
    }

    console.log(await getLocked())
    console.log(await getUserPointHistory(userPointEpoch - 2))
    console.log(await getUserPointHistory(userPointEpoch - 1))
    console.log(await getUserPointHistory(userPointEpoch))
  }
)

task('temp:check:voter:claimable', 'temp:check:voter:claimable').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })
    const signer = await ethers.getSigner(EOA)
    const voter = Voter__factory.connect(addresses.voter, signer)

    console.log(`------- [temp:check:claimable] START -------`)
    console.log(`network ... ${network.name}`)
    const tokens = await voter.tokenList()
    const balances = await voter.claimable()
    for (let i = 0; i < tokens.length; i++) {
      const ltoken = LToken__factory.connect(tokens[i], ethers.provider)
      const decimals = await ltoken.decimals()
      console.log(`${tokens[i]}: ${formatUnits(balances[i], decimals)}`)
    }
    console.log(`------- [temp:check:claimable] END -------`)
  }
)

task('temp:check:voter:weights', 'temp:check:weights').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })
    const signer = await ethers.getSigner(EOA)
    const votingEscrow = VotingEscrow__factory.connect(
      addresses.votingEscrow,
      signer
    )
    const voter = Voter__factory.connect(addresses.voter, signer)

    console.log(`------- [temp:check:weights] START -------`)
    console.log(`network ... ${network.name}`)
    const lId = (await votingEscrow.ownerToId(EOA)).toString()
    const currentTerm = (await voter.currentTermTimestamp()).toNumber()
    const tokens = await voter.tokenList()

    const termMinus2 = currentTerm - 2 * TERM
    const termMinus1 = currentTerm - 1 * TERM
    const termZero = currentTerm
    const termPlus1 = currentTerm + 1 * TERM
    const termPlus2 = currentTerm + 2 * TERM
    const toIsoStr = (t: number) => new Date(t * 1000).toISOString()
    const votesMinus2 = await Promise.all(
      tokens.map((v) => voter.votes(lId, v, termMinus2))
    )
    const votesMinus1 = await Promise.all(
      tokens.map((v) => voter.votes(lId, v, termMinus1))
    )
    const votes = await Promise.all(
      tokens.map((v) => voter.votes(lId, v, termZero))
    )
    const votesPlus1 = await Promise.all(
      tokens.map((v) => voter.votes(lId, v, termPlus1))
    )
    const votesPlus2 = await Promise.all(
      tokens.map((v) => voter.votes(lId, v, termPlus2))
    )
    console.log(`Current - 2: ${toIsoStr(termMinus2)}`)
    for (let i = 0; i < tokens.length; i++)
      console.log(`${tokens[i]}: ${formatEther(votesMinus2[i])}`)
    console.log(``)
    console.log(`Current - 1: ${toIsoStr(termMinus1)}`)
    for (let i = 0; i < tokens.length; i++)
      console.log(`${tokens[i]}: ${formatEther(votesMinus1[i])}`)
    console.log(``)
    console.log(`Current    : ${toIsoStr(termZero)}`)
    for (let i = 0; i < tokens.length; i++)
      console.log(`${tokens[i]}: ${formatEther(votes[i])}`)
    console.log(``)
    console.log(`Current + 1: ${toIsoStr(termPlus1)}`)
    for (let i = 0; i < tokens.length; i++)
      console.log(`${tokens[i]}: ${formatEther(votesPlus1[i])}`)
    console.log(``)
    console.log(`Current + 2: ${toIsoStr(termPlus2)}`)
    for (let i = 0; i < tokens.length; i++)
      console.log(`${tokens[i]}: ${formatEther(votesPlus2[i])}`)
    console.log(``)
    console.log(`------- [temp:check:weights] END -------`)
  }
)

task(
  'temp:check:voter:tokensPerTerm',
  'temp:check:voter:tokensPerTerm'
).setAction(async ({}, hre: HardhatRuntimeEnvironment) => {
  const { ethers, network } = hre
  const { contracts: addresses } = ContractsJsonHelper.load({
    network: network.name,
  })
  const signer = await ethers.getSigner(EOA)
  const votingEscrow = VotingEscrow__factory.connect(
    addresses.votingEscrow,
    signer
  )
  const voter = Voter__factory.connect(addresses.voter, signer)

  console.log(`------- [temp:check:tokensPerTerm] START -------`)
  console.log(`network ... ${network.name}`)
  const currentTerm = (await voter.currentTermTimestamp()).toNumber()
  const tokens = await voter.tokenList()

  const termMinus2 = currentTerm - 2 * TERM
  const termMinus1 = currentTerm - 1 * TERM
  const termZero = currentTerm
  const termPlus1 = currentTerm + 1 * TERM
  const termPlus2 = currentTerm + 2 * TERM
  const termPlus3 = currentTerm + 3 * TERM
  const termPlus4 = currentTerm + 4 * TERM
  const toIsoStr = (t: number) => new Date(t * 1000).toISOString()
  const tokensPerTermMinus2 = await Promise.all(
    tokens.map((v, i) => voter.tokensPerTerm(v, termMinus2))
  )
  const tokensPerTermMinus1 = await Promise.all(
    tokens.map((v, i) => voter.tokensPerTerm(v, termMinus1))
  )
  const tokensPerTerm = await Promise.all(
    tokens.map((v, i) => voter.tokensPerTerm(v, termZero))
  )
  const tokensPerTermPlus1 = await Promise.all(
    tokens.map((v, i) => voter.tokensPerTerm(v, termPlus1))
  )
  const tokensPerTermPlus2 = await Promise.all(
    tokens.map((v, i) => voter.tokensPerTerm(v, termPlus2))
  )
  const tokensPerTermPlus3 = await Promise.all(
    tokens.map((v, i) => voter.tokensPerTerm(v, termPlus3))
  )
  const tokensPerTermPlus4 = await Promise.all(
    tokens.map((v, i) => voter.tokensPerTerm(v, termPlus4))
  )
  console.log(`Current - 2: ${toIsoStr(termMinus2)}`)
  for (let i = 0; i < tokens.length; i++)
    console.log(`${tokens[i]}: ${tokensPerTermMinus2[i].toString()}`)
  // console.log(`${tokens[i]}: ${formatEther(tokensPerTermMinus2[i])}`)
  console.log(``)
  console.log(`Current - 1: ${toIsoStr(termMinus1)}`)
  for (let i = 0; i < tokens.length; i++)
    console.log(`${tokens[i]}: ${tokensPerTermMinus1[i].toString()}`)
  // console.log(`${tokens[i]}: ${formatEther(tokensPerTermMinus1[i])}`)
  console.log(``)
  console.log(`Current    : ${toIsoStr(termZero)}`)
  for (let i = 0; i < tokens.length; i++)
    console.log(`${tokens[i]}: ${tokensPerTerm[i].toString()}`)
  // console.log(`${tokens[i]}: ${formatEther(tokensPerTerm[i])}`)
  console.log(``)
  console.log(`Current + 1: ${toIsoStr(termPlus1)}`)
  for (let i = 0; i < tokens.length; i++)
    console.log(`${tokens[i]}: ${tokensPerTermPlus1[i].toString()}`)
  // console.log(`${tokens[i]}: ${formatEther(tokensPerTermPlus1[i])}`)
  console.log(``)
  console.log(`Current + 2: ${toIsoStr(termPlus2)}`)
  for (let i = 0; i < tokens.length; i++)
    console.log(`${tokens[i]}: ${tokensPerTermPlus2[i].toString()}`)
  // console.log(`${tokens[i]}: ${formatEther(tokensPerTermPlus2[i])}`)
  console.log(``)
  console.log(`Current + 3: ${toIsoStr(termPlus3)}`)
  for (let i = 0; i < tokens.length; i++)
    console.log(`${tokens[i]}: ${tokensPerTermPlus3[i].toString()}`)
  // console.log(`${tokens[i]}: ${formatEther(tokensPerTermPlus3[i])}`)
  console.log(``)
  console.log(`Current + 4: ${toIsoStr(termPlus4)}`)
  for (let i = 0; i < tokens.length; i++)
    console.log(`${tokens[i]}: ${tokensPerTermPlus4[i].toString()}`)
  // console.log(`${tokens[i]}: ${formatEther(tokensPerTermPlus3[i])}`)
  console.log(``)
  console.log(`------- [temp:check:tokensPerTerm] END -------`)
})

task(
  'temp:check:voter:tokenLastBalance',
  'temp:check:voter:tokenLastBalance'
).setAction(async ({}, hre: HardhatRuntimeEnvironment) => {
  const { ethers, network } = hre
  const { contracts: addresses } = ContractsJsonHelper.load({
    network: network.name,
  })
  const signer = await ethers.getSigner(EOA)
  const voter = Voter__factory.connect(addresses.voter, signer)

  console.log(`------- [temp:check:tokenLastBalance] START -------`)
  console.log(`network ... ${network.name}`)
  const tokens = await voter.tokenList()

  for await (const [i, token] of tokens.entries()) {
    const ltoken = LToken__factory.connect(token, ethers.provider)
    const decimals = await ltoken.decimals()
    const _token = await voter.tokens(i)
    const tokenLastBalance = await voter.tokenLastScaledBalance(i)
    console.log({
      fromTokenList: token,
      fromTokens: _token,
      tokenLastBalance: formatUnits(tokenLastBalance, decimals),
    })
    console.log()
  }
  console.log(`------- [temp:check:tokenLastBalance] END -------`)
})
