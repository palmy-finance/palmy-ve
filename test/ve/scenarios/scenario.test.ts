import { JsonRpcProvider } from '@ethersproject/providers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { ContractTransaction } from 'ethers'
import { formatEther, parseEther } from 'ethers/lib/utils'
import { ethers, upgrades } from 'hardhat'
import {
  MockLToken__factory,
  MockLendingPool__factory,
  Token,
  Token__factory,
  Voter,
  Voter__factory,
  VotingEscrow,
  VotingEscrow__factory,
} from '../../../types'
import { HOUR, multiTransferOal, TERM, YEAR } from '../utils'

// Constants
const TOKEN_PARAMETERS: { token: string }[] = [
  { token: 'lWETH' },
  { token: 'lUSDT' },
  { token: 'lUSDC' },
]

// Prepare
const setupMockLTokens = async (
  factory: MockLToken__factory
): Promise<string[]> => {
  const tokens = await Promise.all(
    TOKEN_PARAMETERS.map((p) => factory.deploy(p.token, p.token))
  )
  for await (const token of tokens) {
    await token.deployTransaction.wait()
  }
  return tokens.map((t) => t.address)
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

  const lendingPool = await new MockLendingPool__factory(deployer).deploy()

  const voter = (await upgrades.deployProxy(new Voter__factory(deployer), [
    lendingPool.address,
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
    votingEscrow: votingEscrow,
    voter,
    deployer,
    users: rest,
    mockLTokenAddresses: tokenAddresses,
    lendingPool,
  }
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

const _current = async (provider: JsonRpcProvider) => {
  const currentBlock = await provider.getBlock(await provider.getBlockNumber())
  const currentTerm = Math.floor(currentBlock.timestamp / TERM) * TERM
  return {
    ts: currentBlock.timestamp,
    term: currentTerm,
  }
}

describe('Scenario: vote -> distribute -> claim bonus (protocol fee)', () => {
  const NUM_OF_USERS = 1
  const _setup = async () => {
    ethers.provider.send('evm_mine', [
      (await _current(ethers.provider)).term + 2 * TERM - 1 * HOUR,
    ]) // proceeded time to immediately after the start

    const { oal, votingEscrow, voter, deployer, users, mockLTokenAddresses } =
      await setup()

    const _users = users.splice(0, NUM_OF_USERS)
    const [user] = _users
    await multiTransferOal({
      users: _users,
      length: NUM_OF_USERS,
      amount: parseEther('100'),
      oal,
      holder: deployer,
    })
    await multiApproveToVe({
      users: _users,
      oal,
      votingEscrowAddress: votingEscrow.address,
    })

    let tx: ContractTransaction

    tx = await votingEscrow
      .connect(user)
      .createLock(parseEther('100'), 2 * YEAR)
    await tx.wait()
    const lockerId = (
      await votingEscrow.connect(ethers.provider).ownerToId(user.address)
    ).toNumber()
    expect(lockerId).to.eq(1)

    const initialTerm = (await voter.currentTermTimestamp()).toNumber()
    const weights = [1, 3, 6]
    tx = await voter.connect(user).voteUntil(weights, initialTerm + 4 * TERM) // minus 1 from just term

    const checkVote = async (ts: number) => {
      const votes = await Promise.all(
        mockLTokenAddresses.map((v) =>
          voter.votes(lockerId, v, ts).then((v) => formatEther(v))
        )
      )
      const poolWeights = await Promise.all(
        mockLTokenAddresses.map((v) =>
          voter.poolWeights(v, ts).then((v) => formatEther(v))
        )
      )
      const tokensPerTerms = await Promise.all(
        mockLTokenAddresses.map((v) =>
          voter.tokensPerTerm(v, ts).then((v) => formatEther(v))
        )
      )
      return {
        votes,
        poolWeights,
        tokensPerTerms,
      }
    }
    const checkClaimable = async () => {
      const claimable = await voter.claimableFor(user.address)
      return claimable.map((v) => formatEther(v))
    }
    const voterStatuses = async () => {
      const result = {
        tInitial: await checkVote(initialTerm + 0 * TERM),
        t1: await checkVote(initialTerm + 1 * TERM),
        t2: await checkVote(initialTerm + 2 * TERM),
        t3: await checkVote(initialTerm + 3 * TERM),
        t4: await checkVote(initialTerm + 4 * TERM),
        t5: await checkVote(initialTerm + 5 * TERM),
        t6: await checkVote(initialTerm + 6 * TERM),
        claimable: await checkClaimable(),
      }
      console.log()
      return result
    }
    const callCheckpoints = async () => {
      await (await votingEscrow.checkpoint()).wait()
      await (await voter.checkpointToken()).wait()
    }
    const transfersLTokens = async (amount: number) => {
      for await (const addr of mockLTokenAddresses) {
        const ltoken = MockLToken__factory.connect(addr, deployer)
        const tx = await ltoken.mint(
          voter.address,
          parseEther(amount.toString())
        )
        await tx.wait()
      }
    }

    return {
      votingEscrow,
      voter,
      voterStatuses,
      transfersLTokens,
      callCheckpoints,
      initialTerm,
    }
  }
  describe('check tokensPerTerms/claimable', () => {
    describe('multi transfer', () => {
      it('when mint/transfer only before just at the end term', async () => {
        // Prerequisites
        const {
          voterStatuses,
          transfersLTokens,
          callCheckpoints,
          initialTerm,
        } = await _setup()

        await callCheckpoints()
        const before = await voterStatuses()
        // about votes
        before.tInitial.votes.map((v) => expect(Number(v)).to.eq(0)) // not included in current term
        before.t1.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t2.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t3.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t4.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t5.votes.map((v) => expect(Number(v)).to.eq(0))
        before.t6.votes.map((v) => expect(Number(v)).to.eq(0))
        // about tokenPerWeek
        before.tInitial.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t1.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t2.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t3.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t4.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t5.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t6.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        // about claimable
        before.claimable.map((v) => expect(Number(v)).to.eq(0))

        console.log('##### initialTerm + 1 * TERM - 1 * HOUR') // = initial term
        ethers.provider.send('evm_mine', [initialTerm + 1 * TERM - 1 * HOUR])
        console.log('> call transfer ltoken to Voter')
        await transfersLTokens(1)
        console.log('> call checkpoint')
        await callCheckpoints()
        await voterStatuses() // TODO: assert
        console.log()

        console.log('##### initialTerm + 2 * TERM - 1 * HOUR') // = 1st term
        ethers.provider.send('evm_mine', [initialTerm + 2 * TERM - 1 * HOUR])
        console.log('> call transfer ltoken to Voter')
        await transfersLTokens(2)
        console.log('> call checkpoint')
        await callCheckpoints()
        await voterStatuses() // TODO: assert
        console.log()

        console.log('##### initialTerm + 3 * TERM - 1 * HOUR') // = 2nd term
        ethers.provider.send('evm_mine', [initialTerm + 3 * TERM - 1 * HOUR])
        console.log('> call transfer ltoken to Voter')
        await transfersLTokens(3)
        console.log('> call checkpoint')
        await callCheckpoints()
        await voterStatuses() // TODO: assert
        console.log()
      })

      it('when mint/transfer only after just at the starting term', async () => {
        // Prerequisites
        const {
          voterStatuses,
          transfersLTokens,
          callCheckpoints,
          initialTerm,
        } = await _setup()

        await callCheckpoints()
        const before = await voterStatuses()
        console.log()
        // about votes
        before.tInitial.votes.map((v) => expect(Number(v)).to.eq(0)) // not included in current term
        before.t1.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t2.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t3.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t4.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t5.votes.map((v) => expect(Number(v)).to.eq(0))
        before.t6.votes.map((v) => expect(Number(v)).to.eq(0))
        // about tokenPerWeek
        before.tInitial.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t1.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t2.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t3.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t4.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t5.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t6.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        // about claimable
        before.claimable.map((v) => expect(Number(v)).to.eq(0))

        console.log('##### initialTerm + 1 * TERM + 1') // = 1st term
        ethers.provider.send('evm_mine', [initialTerm + 1 * TERM + 1])
        console.log('> call transfer ltoken to Voter')
        await transfersLTokens(1)
        console.log('> call checkpoint')
        await callCheckpoints()
        await voterStatuses() // TODO: assert
        console.log()

        console.log('##### initialTerm + 2 * TERM + 1') // = 2nd term
        ethers.provider.send('evm_mine', [initialTerm + 2 * TERM + 1])
        console.log('> call transfer ltoken to Voter')
        await transfersLTokens(2)
        console.log('> call checkpoint')
        await callCheckpoints()
        await voterStatuses() // TODO: assert
        console.log()

        console.log('##### initialTerm + 3 * TERM + 1') // = 3rd term
        ethers.provider.send('evm_mine', [initialTerm + 3 * TERM + 1])
        console.log('> call transfer ltoken to Voter')
        await transfersLTokens(3)
        console.log('> call checkpoint')
        await callCheckpoints()
        await voterStatuses() // TODO: assert
        console.log()
      })
    })
    describe('single transfer', () => {
      it('when mint/transfer only before just at the end term', async () => {
        // Prerequisites
        const {
          voterStatuses,
          transfersLTokens,
          callCheckpoints,
          initialTerm,
        } = await _setup()

        await callCheckpoints()
        const before = await voterStatuses()
        console.log()
        // about votes
        before.tInitial.votes.map((v) => expect(Number(v)).to.eq(0)) // not included in current term
        before.t1.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t2.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t3.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t4.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t5.votes.map((v) => expect(Number(v)).to.eq(0))
        before.t6.votes.map((v) => expect(Number(v)).to.eq(0))
        // about tokenPerWeek
        before.tInitial.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t1.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t2.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t3.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t4.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t5.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t6.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        // about claimable
        before.claimable.map((v) => expect(Number(v)).to.eq(0))

        console.log('##### initialTerm + 1 * TERM - 1 * HOUR') // = initial term
        ethers.provider.send('evm_mine', [initialTerm + 1 * TERM - 1 * HOUR])
        console.log('> call checkpoint')
        await callCheckpoints()

        console.log('##### initialTerm + 2 * TERM - 1 * HOUR') // = 1st term
        ethers.provider.send('evm_mine', [initialTerm + 2 * TERM - 1 * HOUR])
        console.log('> call checkpoint')
        await callCheckpoints()

        console.log('##### initialTerm + 3 * TERM - 1 * HOUR') // = 2nd term
        ethers.provider.send('evm_mine', [initialTerm + 3 * TERM - 1 * HOUR])
        console.log('> call transfer ltoken to Voter')
        await transfersLTokens(3)
        console.log('> call checkpoint')
        await callCheckpoints()
        const status2nd = await voterStatuses()
        console.log()
        // about tokenPerWeek
        status2nd.tInitial.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        status2nd.t1.tokensPerTerms.map((v) =>
          expect(Number(v)).to.greaterThan(0)
        )
        status2nd.t2.tokensPerTerms.map((v) => expect(Number(v)).to.lessThan(3))
        status2nd.t2.tokensPerTerms.map((v) =>
          expect(Number(v)).to.greaterThanOrEqual(2.95)
        )
        status2nd.t3.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        status2nd.t4.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        status2nd.t5.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        status2nd.t6.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        // about claimable
        status2nd.claimable.map((v) => expect(Number(v)).to.lessThan(1))
        status2nd.claimable.map((v) => expect(Number(v)).to.greaterThan(0))
      })

      it('when mint/transfer only after just at the starting term', async () => {
        // Prerequisites
        const {
          voterStatuses,
          transfersLTokens,
          callCheckpoints,
          initialTerm,
        } = await _setup()

        await callCheckpoints()
        const before = await voterStatuses()
        console.log()
        // about votes
        before.tInitial.votes.map((v) => expect(Number(v)).to.eq(0)) // not included in current term
        before.t1.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t2.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t3.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t4.votes.map((v) => expect(Number(v)).to.greaterThan(0))
        before.t5.votes.map((v) => expect(Number(v)).to.eq(0))
        before.t6.votes.map((v) => expect(Number(v)).to.eq(0))
        // about tokenPerWeek
        before.tInitial.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t1.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t2.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t3.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t4.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t5.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        before.t6.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        // about claimable
        before.claimable.map((v) => expect(Number(v)).to.eq(0))

        console.log('##### initialTerm + 1 * TERM + 1') // = 1st term
        ethers.provider.send('evm_mine', [initialTerm + 1 * TERM + 1])
        console.log('> call checkpoint')
        await callCheckpoints()

        console.log('##### initialTerm + 2 * TERM + 1') // = 2nd term
        ethers.provider.send('evm_mine', [initialTerm + 2 * TERM + 1])
        console.log('> call checkpoint')
        await callCheckpoints()

        console.log('##### initialTerm + 3 * TERM + 1') // = 3rd term
        ethers.provider.send('evm_mine', [initialTerm + 3 * TERM + 1])
        console.log('> call transfer ltoken to Voter')
        await transfersLTokens(3)
        console.log('> call checkpoint')
        await callCheckpoints()
        const status3rd = await voterStatuses()
        console.log()
        // about tokenPerWeek
        status3rd.tInitial.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        status3rd.t1.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        status3rd.t2.tokensPerTerms.map((v) => expect(Number(v)).to.lessThan(3))
        status3rd.t2.tokensPerTerms.map((v) =>
          expect(Number(v)).to.greaterThanOrEqual(2.95)
        )
        status3rd.t3.tokensPerTerms.map((v) =>
          expect(Number(v)).to.greaterThan(0)
        )
        status3rd.t4.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        status3rd.t5.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        status3rd.t6.tokensPerTerms.map((v) => expect(Number(v)).to.eq(0))
        // about claimable
        status3rd.claimable.map((v) => expect(Number(v)).to.lessThan(3))
        status3rd.claimable.map((v) =>
          expect(Number(v)).to.greaterThanOrEqual(2.95)
        )
      })
    })
  })
})

describe.only('Scenario: vote after some terms passed & add new token', () => {
  let beginTime: number
  let provider: JsonRpcProvider
  let deployer: SignerWithAddress
  let oal: Token
  let voter: Voter
  let votingEscrow: VotingEscrow
  let user: SignerWithAddress
  let mockLTokenAddresses: string[]
  let checkVote: (
    _lockerId: number,
    _ts: number,
    _ltokens: string[]
  ) => Promise<{
    votes: string[]
    poolWeights: string[]
    tokensPerTerms: string[]
  }>
  let transfersLTokens: (
    params: { ltoken: string; amount: number }[]
  ) => Promise<void>
  let callCheckpoints: () => Promise<void>

  before(async () => {
    beginTime = (await _current(ethers.provider)).term + TERM - 1 * HOUR
    ethers.provider.send('evm_mine', [beginTime]) // proceeded time to immediately after the start

    const inputs = await setup()
    provider = inputs.provider
    deployer = inputs.deployer
    oal = inputs.oal
    voter = inputs.voter
    votingEscrow = inputs.votingEscrow
    user = inputs.users[0]
    mockLTokenAddresses = inputs.mockLTokenAddresses

    checkVote = async (_lockerId: number, _ts: number, _ltokens: string[]) => {
      const votes = await Promise.all(
        _ltokens.map((v) =>
          voter.votes(_lockerId, v, _ts).then((v) => formatEther(v))
        )
      )
      const poolWeights = await Promise.all(
        _ltokens.map((v) =>
          voter.poolWeights(v, _ts).then((v) => formatEther(v))
        )
      )
      const tokensPerTerms = await Promise.all(
        _ltokens.map((v) =>
          voter.tokensPerTerm(v, _ts).then((v) => formatEther(v))
        )
      )
      console.log(`# term: ${new Date(_ts * 1000).toISOString()}`)
      console.log(`votes         : ${votes}`)
      console.log(`poolWeights   : ${poolWeights}`)
      console.log(`tokensPerTerms: ${tokensPerTerms}`)
      return {
        votes,
        poolWeights,
        tokensPerTerms,
      }
    }

    transfersLTokens = async (params: { ltoken: string; amount: number }[]) => {
      for await (const param of params) {
        const ltoken = MockLToken__factory.connect(param.ltoken, deployer)
        const tx = await ltoken.mint(
          voter.address,
          parseEther(param.amount.toString())
        )
        await tx.wait()
      }
    }

    callCheckpoints = async () => {
      await (await votingEscrow.checkpoint()).wait()
      await (await voter.checkpointToken()).wait()
    }
  })

  it('Prerequisites: check current tokens', async () => {
    const tokenList = await voter.tokenList()
    expect(tokenList.length).to.eq(mockLTokenAddresses.length)
    for (let i = 0; i < tokenList.length; i++)
      expect(tokenList[i].toLowerCase()).to.eq(
        mockLTokenAddresses[i].toLowerCase()
      )
  })
  it('Prerequisites: some terms passed (lock, vote)', async () => {
    // Prepares
    await multiTransferOal({
      users: [user],
      length: 1,
      amount: parseEther('100'),
      oal,
      holder: deployer,
    })
    await multiApproveToVe({
      users: [user],
      oal,
      votingEscrowAddress: votingEscrow.address,
    })

    // Execute
    //// in initial term
    ////// create lock & vote
    let tx: ContractTransaction
    const amount = 100
    tx = await votingEscrow
      .connect(user)
      .createLock(parseEther(amount.toString()), 2 * YEAR)
    await tx.wait()

    const lockerId = (
      await votingEscrow.connect(ethers.provider).ownerToId(user.address)
    ).toNumber()
    expect(lockerId).to.eq(1)

    const initialTerm = (await voter.currentTermTimestamp()).toNumber()
    const weights = [1, 0, 3]
    tx = await voter.connect(user).voteUntil(weights, initialTerm + 3 * TERM) // minus 1 from just term
    await tx.wait()
    const ADJUSTED_RATIO = 0.95

    const result_1_0 = await checkVote(
      lockerId,
      initialTerm,
      mockLTokenAddresses
    )
    for (const vote of result_1_0.votes) {
      expect(Number(vote)).to.eq(0)
    }
    for (const poolWeight of result_1_0.poolWeights) {
      expect(Number(poolWeight)).to.eq(0)
    }
    for (const tokensPerTerm of result_1_0.tokensPerTerms) {
      expect(Number(tokensPerTerm)).to.eq(0)
    }

    const result_1_1 = await checkVote(
      lockerId,
      initialTerm + TERM,
      mockLTokenAddresses
    )
    expect(Number(result_1_1.votes[0])).to.gt(25 * ADJUSTED_RATIO)
    expect(Number(result_1_1.votes[1])).to.eq(0)
    expect(Number(result_1_1.votes[2])).to.gt(75 * ADJUSTED_RATIO)
    expect(Number(result_1_1.poolWeights[0])).to.gt(25 * ADJUSTED_RATIO)
    expect(Number(result_1_1.poolWeights[1])).to.eq(0)
    expect(Number(result_1_1.poolWeights[2])).to.gt(75 * ADJUSTED_RATIO)
    for (const tokensPerTerm of result_1_1.tokensPerTerms)
      expect(Number(tokensPerTerm)).to.eq(0)

    const result_1_2 = await checkVote(
      lockerId,
      initialTerm + 2 * TERM,
      mockLTokenAddresses
    )
    expect(Number(result_1_2.votes[0])).to.gt(25 * ADJUSTED_RATIO)
    expect(Number(result_1_2.votes[1])).to.eq(0)
    expect(Number(result_1_2.votes[2])).to.gt(75 * ADJUSTED_RATIO)
    expect(Number(result_1_2.poolWeights[0])).to.gt(25 * ADJUSTED_RATIO)
    expect(Number(result_1_2.poolWeights[1])).to.eq(0)
    expect(Number(result_1_2.poolWeights[2])).to.gt(75 * ADJUSTED_RATIO)
    for (const tokensPerTerm of result_1_2.tokensPerTerms)
      expect(Number(tokensPerTerm)).to.eq(0)

    const result_1_3 = await checkVote(
      lockerId,
      initialTerm + 3 * TERM,
      mockLTokenAddresses
    )
    expect(Number(result_1_3.votes[0])).to.gt(25 * ADJUSTED_RATIO)
    expect(Number(result_1_3.votes[1])).to.eq(0)
    expect(Number(result_1_3.votes[2])).to.gt(75 * ADJUSTED_RATIO)
    expect(Number(result_1_3.poolWeights[0])).to.gt(25 * ADJUSTED_RATIO)
    expect(Number(result_1_3.poolWeights[1])).to.eq(0)
    expect(Number(result_1_3.poolWeights[2])).to.gt(75 * ADJUSTED_RATIO)
    for (const tokensPerTerm of result_1_3.tokensPerTerms)
      expect(Number(tokensPerTerm)).to.eq(0)

    const result_1_4 = await checkVote(
      lockerId,
      initialTerm + 4 * TERM,
      mockLTokenAddresses
    )
    for (const vote of result_1_4.votes) {
      expect(Number(vote)).to.eq(0)
    }
    for (const poolWeight of result_1_4.poolWeights) {
      expect(Number(poolWeight)).to.eq(0)
    }
    for (const tokensPerTerm of result_1_4.tokensPerTerms)
      expect(Number(tokensPerTerm)).to.eq(0)

    //// in 1st term (immediately before 2nd term)
    ethers.provider.send('evm_mine', [initialTerm + 2 * TERM - 1 * HOUR])
    await transfersLTokens([
      { ltoken: mockLTokenAddresses[0], amount: 100 },
      { ltoken: mockLTokenAddresses[1], amount: 1000 },
      { ltoken: mockLTokenAddresses[2], amount: 10000 },
    ])
    await callCheckpoints()

    //// in 2nd term (immediately before 3rd term)
    ethers.provider.send('evm_mine', [initialTerm + 3 * TERM - 1 * HOUR])
    await transfersLTokens([
      { ltoken: mockLTokenAddresses[0], amount: 100 },
      { ltoken: mockLTokenAddresses[1], amount: 1000 },
      { ltoken: mockLTokenAddresses[2], amount: 10000 },
    ])
    await callCheckpoints()

    const result_2_0 = await checkVote(
      lockerId,
      initialTerm,
      mockLTokenAddresses
    )
    for (const tokensPerTerm of result_2_0.tokensPerTerms)
      expect(Number(tokensPerTerm)).to.above(0)
    const result_2_1 = await checkVote(
      lockerId,
      initialTerm + TERM,
      mockLTokenAddresses
    )
    expect(Number(result_2_1.tokensPerTerms[0])).to.gt(98)
    expect(Number(result_2_1.tokensPerTerms[1])).to.gt(980)
    expect(Number(result_2_1.tokensPerTerms[2])).to.gt(9800)
    const result_2_2 = await checkVote(
      lockerId,
      initialTerm + 2 * TERM,
      mockLTokenAddresses
    )
    expect(Number(result_2_2.tokensPerTerms[0])).to.gt(98)
    expect(Number(result_2_2.tokensPerTerms[1])).to.gt(980)
    expect(Number(result_2_2.tokensPerTerms[2])).to.gt(9800)
    const result_2_3 = await checkVote(
      lockerId,
      initialTerm + 3 * TERM,
      mockLTokenAddresses
    )
    for (const tokensPerTerm of result_2_3.tokensPerTerms)
      expect(Number(tokensPerTerm)).to.eq(0)
    const result_2_4 = await checkVote(
      lockerId,
      initialTerm + 4 * TERM,
      mockLTokenAddresses
    )
    for (const tokensPerTerm of result_2_4.tokensPerTerms)
      expect(Number(tokensPerTerm)).to.eq(0)
  })
  it('1. .addToken', async () => {
    const ltoken1 = await new MockLToken__factory(deployer).deploy(
      'token1',
      'TOKEN1'
    )
    await ltoken1.deployTransaction.wait()
    await (await voter.connect(deployer).addToken(ltoken1.address)).wait()
    const ltoken2 = await new MockLToken__factory(deployer).deploy(
      'token1',
      'TOKEN1'
    )
    await ltoken2.deployTransaction.wait()
    await (await voter.connect(deployer).addToken(ltoken2.address)).wait()

    const tokenList = await voter.tokenList()
    expect(mockLTokenAddresses.length + 2).to.eq(tokenList.length)
    expect(
      [...mockLTokenAddresses, ltoken1.address, ltoken2.address].toString()
    ).to.eq(tokenList.toString())
  })
  it('2. vote', async () => {
    let tx: ContractTransaction

    const tokenList = await voter.tokenList()
    const currentTerm = (await voter.currentTermTimestamp()).toNumber()
    const nextTermStart = currentTerm + 1 * TERM + 1

    // vote
    await expect(
      voter.connect(user).voteUntil([1, 0, 3], nextTermStart)
    ).to.revertedWith('Must be the same length: tokens, _weight')
    await expect(
      voter.connect(user).voteUntil([1, 0, 3, 0], nextTermStart)
    ).to.revertedWith('Must be the same length: tokens, _weight')
    //// success
    tx = await voter.connect(user).voteUntil([1, 0, 3, 0, 1], nextTermStart)
    await tx.wait()

    const lockerId = (
      await votingEscrow.connect(ethers.provider).ownerToId(user.address)
    ).toNumber()

    // check status after vote
    console.log(
      `# current time: ${new Date(
        (await _current(ethers.provider)).ts * 1000
      ).toISOString()}`
    )
    const ADJUSTED_RATIO = 0.95
    const result_1_2 = await checkVote(lockerId, currentTerm, tokenList)
    expect(Number(result_1_2.votes[0])).to.gt(25 * ADJUSTED_RATIO)
    expect(Number(result_1_2.votes[1])).to.eq(0)
    expect(Number(result_1_2.votes[2])).to.gt(75 * ADJUSTED_RATIO)
    expect(Number(result_1_2.votes[3])).to.eq(0)
    expect(Number(result_1_2.votes[4])).to.eq(0)
    expect(Number(result_1_2.poolWeights[0])).to.gt(25 * ADJUSTED_RATIO)
    expect(Number(result_1_2.poolWeights[1])).to.eq(0)
    expect(Number(result_1_2.poolWeights[2])).to.gt(75 * ADJUSTED_RATIO)
    expect(Number(result_1_2.poolWeights[3])).to.eq(0)
    expect(Number(result_1_2.poolWeights[4])).to.eq(0)
    expect(Number(result_1_2.tokensPerTerms[0])).to.gt(100 * ADJUSTED_RATIO)
    expect(Number(result_1_2.tokensPerTerms[1])).to.gt(1000 * ADJUSTED_RATIO)
    expect(Number(result_1_2.tokensPerTerms[2])).to.gt(10000 * ADJUSTED_RATIO)
    expect(Number(result_1_2.tokensPerTerms[3])).to.eq(0)
    expect(Number(result_1_2.tokensPerTerms[4])).to.eq(0)

    const result_1_3 = await checkVote(
      lockerId,
      currentTerm + 1 * TERM,
      tokenList
    )
    expect(Number(result_1_3.votes[0])).to.gt(20 * ADJUSTED_RATIO)
    expect(Number(result_1_3.votes[1])).to.eq(0)
    expect(Number(result_1_3.votes[2])).to.gt(60 * ADJUSTED_RATIO)
    expect(Number(result_1_3.votes[3])).to.eq(0)
    expect(Number(result_1_3.votes[4])).to.gt(20 * ADJUSTED_RATIO)
    expect(Number(result_1_3.poolWeights[0])).to.gt(20 * ADJUSTED_RATIO)
    expect(Number(result_1_3.poolWeights[1])).to.eq(0)
    expect(Number(result_1_3.poolWeights[2])).to.gt(60 * ADJUSTED_RATIO)
    expect(Number(result_1_3.poolWeights[3])).to.eq(0)
    expect(Number(result_1_3.poolWeights[4])).to.gt(20 * ADJUSTED_RATIO)
    for (const tokensPerTerm of result_1_3.tokensPerTerms)
      expect(Number(tokensPerTerm)).to.eq(0)

    const result_1_4 = await checkVote(
      lockerId,
      currentTerm + 2 * TERM,
      tokenList
    )
    for (const vote of result_1_4.votes) expect(Number(vote)).to.eq(0)
    for (const poolWeight of result_1_4.poolWeights)
      expect(Number(poolWeight)).to.eq(0)
    for (const tokensPerTerm of result_1_4.tokensPerTerms)
      expect(Number(tokensPerTerm)).to.eq(0)

    //// reset reward by .claim
    // console.log((await voter.connect(user).claimable()).toString())
    await (await voter.connect(user).claim()).wait()

    // process next term & increase distributions & checkpoint
    await ethers.provider.send('evm_mine', [currentTerm + 2 * TERM - 1 * HOUR])
    await transfersLTokens([
      { ltoken: tokenList[0], amount: 100 },
      { ltoken: tokenList[1], amount: 1000 },
      { ltoken: tokenList[2], amount: 10000 },
      { ltoken: tokenList[3], amount: 100000 },
      { ltoken: tokenList[4], amount: 1000000 },
    ])
    await callCheckpoints()

    // check status after increasing ltoken balances in voter
    console.log(
      `# current time: ${new Date(
        (await _current(ethers.provider)).ts * 1000
      ).toISOString()}`
    )
    const result_2_2 = await checkVote(lockerId, currentTerm, tokenList)
    expect(Number(result_2_2.votes[0])).to.gt(25 * ADJUSTED_RATIO)
    expect(Number(result_2_2.votes[1])).to.eq(0)
    expect(Number(result_2_2.votes[2])).to.gt(75 * ADJUSTED_RATIO)
    expect(Number(result_2_2.votes[3])).to.eq(0)
    expect(Number(result_2_2.votes[4])).to.eq(0)
    expect(Number(result_2_2.poolWeights[0])).to.gt(25 * ADJUSTED_RATIO)
    expect(Number(result_2_2.poolWeights[1])).to.eq(0)
    expect(Number(result_2_2.poolWeights[2])).to.gt(75 * ADJUSTED_RATIO)
    expect(Number(result_2_2.poolWeights[3])).to.eq(0)
    expect(Number(result_2_2.poolWeights[4])).to.eq(0)
    expect(Number(result_2_2.tokensPerTerms[0])).to.gt(100 * ADJUSTED_RATIO)
    expect(Number(result_2_2.tokensPerTerms[1])).to.gt(1000 * ADJUSTED_RATIO)
    expect(Number(result_2_2.tokensPerTerms[2])).to.gt(10000 * ADJUSTED_RATIO)
    expect(Number(result_2_2.tokensPerTerms[3])).to.gt(0) // only a few will be distributed as there are a few hours left
    expect(Number(result_2_2.tokensPerTerms[4])).to.gt(0) // only a few will be distributed as there are a few hours left

    const result_2_3 = await checkVote(
      lockerId,
      currentTerm + 1 * TERM,
      tokenList
    )
    expect(Number(result_2_3.votes[0])).to.gt(20 * ADJUSTED_RATIO)
    expect(Number(result_2_3.votes[1])).to.eq(0)
    expect(Number(result_2_3.votes[2])).to.gt(60 * ADJUSTED_RATIO)
    expect(Number(result_2_3.votes[3])).to.eq(0)
    expect(Number(result_2_3.votes[4])).to.gt(20 * ADJUSTED_RATIO)
    expect(Number(result_2_3.poolWeights[0])).to.gt(20 * ADJUSTED_RATIO)
    expect(Number(result_2_3.poolWeights[1])).to.eq(0)
    expect(Number(result_2_3.poolWeights[2])).to.gt(60 * ADJUSTED_RATIO)
    expect(Number(result_2_3.poolWeights[3])).to.eq(0)
    expect(Number(result_2_3.poolWeights[4])).to.gt(20 * ADJUSTED_RATIO)
    expect(Number(result_2_3.tokensPerTerms[0])).to.gt(100 * ADJUSTED_RATIO)
    expect(Number(result_2_3.tokensPerTerms[1])).to.gt(1000 * ADJUSTED_RATIO)
    expect(Number(result_2_3.tokensPerTerms[2])).to.gt(10000 * ADJUSTED_RATIO)
    expect(Number(result_2_3.tokensPerTerms[3])).to.gt(100000 * ADJUSTED_RATIO)
    expect(Number(result_2_3.tokensPerTerms[4])).to.gt(1000000 * ADJUSTED_RATIO)

    const result_2_4 = await checkVote(
      lockerId,
      currentTerm + 2 * TERM,
      tokenList
    )
    for (const vote of result_2_4.votes) expect(Number(vote)).to.eq(0)
    for (const poolWeight of result_2_4.poolWeights)
      expect(Number(poolWeight)).to.eq(0)
    for (const tokensPerTerm of result_2_4.tokensPerTerms)
      expect(Number(tokensPerTerm)).to.eq(0)

    //// reset reward by .claim
    // console.log((await voter.connect(user).claimable()).toString())
    await (await voter.connect(user).claim()).wait()

    // check .claimable
    await ethers.provider.send('evm_mine', [currentTerm + 2 * TERM + 1])
    console.log(
      `# current time: ${new Date(
        (await _current(ethers.provider)).ts * 1000
      ).toISOString()}`
    )
    await callCheckpoints()
    //// check value from .claimable
    const claimable = await voter.connect(user).claimable()
    expect(Number(formatEther(claimable[3]))).to.eq(0)
    expect(Number(formatEther(claimable[4]))).to.gt(1000000 * ADJUSTED_RATIO)
    //// check .claim
    await (await voter.connect(user).claim()).wait()
    const ltoken1 = Token__factory.connect(tokenList[3], provider)
    expect(Number(formatEther(await ltoken1.balanceOf(user.address)))).eq(0)
    const ltoken2 = Token__factory.connect(tokenList[4], provider)
    expect(Number(formatEther(await ltoken2.balanceOf(user.address)))).eq(
      Number(formatEther(claimable[4]))
    )
  })
})
