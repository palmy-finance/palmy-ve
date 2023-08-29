import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { BigNumber, ContractTransaction } from 'ethers'
import { parseEther } from 'ethers/lib/utils'
import '@openzeppelin/hardhat-upgrades'
import { ethers, upgrades } from 'hardhat'
import {
  MockLToken__factory,
  Token__factory,
  VotingEscrow__factory,
  VotingEscrow,
  Voter__factory,
  Voter,
  Token,
} from '../../types'

// Constants
const HOUR = 60 * 60 // in minute
const DAY = HOUR * 24
const WEEK = 7 * DAY
const MONTH = 4 * WEEK
const YEAR = 12 * MONTH

// [NOTE] Please modify here to change parameters
const PARAMETERS: { token: string; weight: number }[] = [
  { token: 'lWASTR', weight: 1 },
  { token: 'lWSDN', weight: 1 },
  { token: 'lWBTC', weight: 1 },
  { token: 'lWETH', weight: 1 },
  { token: 'lUSDT', weight: 1 },
  { token: 'lUSDC', weight: 1 },
  { token: 'lOAL', weight: 1 },
  { token: 'lBUSD', weight: 1 },
  { token: 'lDAI', weight: 1 },
  { token: 'lMATIC', weight: 1 },
  { token: 'lBNB', weight: 1 },
  { token: 'lDOT', weight: 1 },
]

// Prepare
const setupMockLTokens = async (
  factory: MockLToken__factory
): Promise<string[]> => {
  const tokens = await Promise.all(
    PARAMETERS.map((p) => factory.deploy(p.token, p.token))
  )
  for await (const token of tokens) {
    await token.deployTransaction.wait()
  }
  return tokens.map((t) => t.address)
}

const multiTransferOal = async ({
  users,
  length,
  amount,
  oal,
  holder,
}: {
  users: SignerWithAddress[]
  length: number
  amount: BigNumber
  oal: Token
  holder: SignerWithAddress
}) => {
  const _oal = oal.connect(holder)
  const fns = [...Array(length)].map((_, i) =>
    _oal.transfer(users[i].address, amount)
  )
  const txs = await Promise.all(fns)
  for await (const tx of txs) tx.wait()
}

const multiApproveToVe = async ({
  users,
   oal,
  votingEscrowAddress,
}: {
  users: SignerWithAddress[]
  oal: Token
  votingEscrowAddress: string
}) => {
  for await (const user of users) {
    const tx = await oal
      .connect(user)
      .approve(votingEscrowAddress, ethers.constants.MaxUint256)
    await tx.wait()
  }
}

const setup = async () => {
  const [deployer, ...rest] = await ethers.getSigners()
  const oal = await new Token__factory(deployer).deploy(
    'OAL',
    'OAL',
    parseEther('100000'),
    await deployer.getAddress()
  )
  await oal.deployTransaction.wait()
  const votingEscrow = (await upgrades.deployProxy(
    new VotingEscrow__factory(deployer),
    [oal.address]
  )) as VotingEscrow
  await votingEscrow.deployTransaction.wait()
  const voter = (await upgrades.deployProxy(new Voter__factory(deployer), [
    votingEscrow.address,
  ])) as Voter
  await voter.deployTransaction.wait()

  // initialize
  const tokenAddresses = await setupMockLTokens(
    new MockLToken__factory(deployer)
  )
  for await (const token of tokenAddresses) {
    const tx = await voter.addToken(token)
    await tx.wait()
  }
  const tx = await votingEscrow.setVoter(voter.address)
  await tx.wait()

  return {
    provider: ethers.provider,
    oal,
    votingEscrow,
    voter,
    deployer,
    users: rest,
    mockLTokenAddresses: tokenAddresses,
  }
}

describe('Confirming performance of Voter#vote (ver2)', () => {
  // Setup until transfer oal, approve after deployments
  const _setup = async (numOfUsers: number, amount?: BigNumber) => {
    const {
      provider,
       oal,
      votingEscrow,
      voter,
      deployer,
      users,
      mockLTokenAddresses,
    } = await setup()

    const _users = users.splice(0, numOfUsers)
    await multiTransferOal({
      users: _users,
      length: _users.length,
      amount: amount ? amount : BigNumber.from('10000'),
       oal,
      holder: deployer,
    })
    await multiApproveToVe({
      users: _users,
       oal,
      votingEscrowAddress: votingEscrow.address,
    })
    return {
      provider,
      votingEscrow,
      voter,
      users: _users,
      mockLTokenAddresses,
    }
  }
  const confirm = async (_lockDuration: number) => {
    const AMOUNT = parseEther('1')
    const { provider, votingEscrow, voter, users } = await _setup(1, AMOUNT)
    let tx: ContractTransaction
    const [user] = users

    // Pre-processing: Adjust current time to just before term period
    const _currentTermTimestamp = Number(
      await voter.connect(provider).currentTermTimestamp()
    )
    ethers.provider.send('evm_mine', [_currentTermTimestamp + WEEK - 3 * HOUR])

    tx = await votingEscrow.connect(user).createLock(AMOUNT, _lockDuration)
    await tx.wait()

    const weights = PARAMETERS.map((p) => p.weight)
    const estimation = await voter.connect(user).estimateGas.vote(weights, {
      gasLimit: 1000 * 1000 * 1000, // 15 * 1000 * 1000
    })
    tx = await voter.connect(user).vote(weights)
    await tx.wait()

    // Pre-processing: run Voter#checkpoint weekly
    let index = 1
    while (index * WEEK < _lockDuration - 3 * WEEK) {
      ethers.provider.send('evm_mine', [_currentTermTimestamp + index * WEEK])
      tx = await voter.checkpointToken()
      await tx.wait()
      index++
    }
    console.log(`proceeded ${index} * WEEK`)

    // Execute
    ethers.provider.send('evm_mine', [
      _currentTermTimestamp + _lockDuration - 2 * WEEK,
    ])
    const _estimation = await voter.connect(user).estimateGas.vote(weights, {
      gasLimit: 1000 * 1000 * 1000, // 15 * 1000 * 1000
    })
    // console.log(_estimation.toString())
    // tx = await voter.connect(user).vote(weights)
    // await tx.wait()
    return [estimation, _estimation]
  }
  const NUMBER_OF_TRIALS = 3

  describe('LOCK_DURATION = 1 month', () => {
    for (let i = 0; i < NUMBER_OF_TRIALS; i++) {
      it(`${i + 1}`, async () => {
        const _result = await confirm(1 * MONTH)
        console.log(`1 month  no.${i}: ${_result}`)
      }).timeout(300 * 1000)
    }
  })
  describe('LOCK_DURATION = 2 month', () => {
    for (let i = 0; i < NUMBER_OF_TRIALS; i++) {
      it(`${i + 1}`, async () => {
        const _result = await confirm(2 * MONTH)
        console.log(`2 month  no.${i}: ${_result}`)
      }).timeout(300 * 1000)
    }
  })
  describe('LOCK_DURATION = 3 month', () => {
    for (let i = 0; i < NUMBER_OF_TRIALS; i++) {
      it(`${i + 1}`, async () => {
        const _result = await confirm(3 * MONTH)
        console.log(`3 month  no.${i}: ${_result}`)
      }).timeout(300 * 1000)
    }
  })
  describe('LOCK_DURATION = 0.5 year', () => {
    for (let i = 0; i < NUMBER_OF_TRIALS; i++) {
      it(`${i + 1}`, async () => {
        const _result = await confirm(0.5 * YEAR)
        console.log(`0.5 year no.${i}: ${_result}`)
      }).timeout(300 * 1000)
    }
  })
  describe('LOCK_DURATION = 1 year', () => {
    for (let i = 0; i < NUMBER_OF_TRIALS; i++) {
      it(`${i + 1}`, async () => {
        const _result = await confirm(1 * YEAR)
        console.log(`1.0 year no.${i}: ${_result}`)
      }).timeout(300 * 1000)
    }
  })
  describe('LOCK_DURATION = 1.5 year', () => {
    for (let i = 0; i < NUMBER_OF_TRIALS; i++) {
      it(`${i + 1}`, async () => {
        const _result = await confirm(1.5 * YEAR)
        console.log(`1.5 year no.${i}: ${_result}`)
      }).timeout(300 * 1000)
    }
  })
  describe('LOCK_DURATION = 2 year', () => {
    for (let i = 0; i < NUMBER_OF_TRIALS; i++) {
      it(`${i + 1}`, async () => {
        const _result = await confirm(2 * YEAR)
        console.log(`2 year no.${i}: ${_result}`)
      }).timeout(300 * 1000)
    }
  })
})
