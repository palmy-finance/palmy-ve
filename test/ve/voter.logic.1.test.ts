import { JsonRpcProvider } from '@ethersproject/providers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { BigNumber, ContractTransaction } from 'ethers'
import { formatEther, parseEther } from 'ethers/lib/utils'
import { ethers, upgrades } from 'hardhat'
import {
  MockLToken__factory,
  Token,
  Token__factory,
  VotingEscrow__factory,
  VotingEscrow,
  Voter__factory,
  Voter,
} from '../../types'

// Constants
const HOUR = 60 * 60 // in minute
const DAY = HOUR * 24
const WEEK = 7 * DAY
const MONTH = 4 * WEEK
const YEAR = 12 * MONTH

const PARAMETERS: { token: string; weight: number }[] = [
  { token: 'lDAI', weight: 1 },

  // { token: 'lWASTR', weight: 1 },
  // { token: 'lWSDN', weight: 1 },
  // { token: 'lWBTC', weight: 1 },
  // { token: 'lWETH', weight: 1 },
  // { token: 'lUSDT', weight: 1 },
  // { token: 'lUSDC', weight: 1 },
  // { token: 'lOAL', weight: 1 },
  // { token: 'lBUSD', weight: 1 },
  // { token: 'lDAI', weight: 1 },
  // { token: 'lMATIC', weight: 1 },
  // { token: 'lBNB', weight: 1 },
  // { token: 'lDOT', weight: 1 },
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

// For Logics
const TERM = 1 * WEEK

const logTs = (ts: number) => console.log(new Date(ts * 1000).toISOString())
const _current = async (provider: JsonRpcProvider) => {
  const currentBlock = await provider.getBlock(await provider.getBlockNumber())
  const currentTerm = Math.floor(currentBlock.timestamp / TERM) * TERM
  return {
    ts: currentBlock.timestamp,
    term: currentTerm,
  }
}
const _currentFromVoter = async (voter: Voter) => {
  const [tIndex, tTs] = await Promise.all([
    voter.currentTermIndex().then((v) => v.toNumber()),
    voter.currentTermTimestamp().then((v) => v.toNumber()),
  ])
  return {
    idx: tIndex,
    ts: tTs,
  }
}

describe('Confirming logic of distributions', () => {
  const checkCurrent = async (provider: JsonRpcProvider, voter: Voter) => {
    const current = await _current(ethers.provider)
    const curVoter = await _currentFromVoter(voter)
    logTs(current.ts)
    logTs(current.term)
    console.log('## from Voter')
    console.log(curVoter.idx)
    logTs(curVoter.ts)

    return {
      provider: {
        ts: current.ts,
        term: current.term,
      },
      voter: {
        idx: curVoter.idx,
        ts: curVoter.ts,
      },
    }
  }

  describe('check terms', () => {
    it('', async () => {
      const start = await _current(ethers.provider)
      ethers.provider.send('evm_mine', [start.term + TERM - 3 * HOUR])

      console.log('# Current')
      ethers.provider.send('evm_increaseTime', [TERM])
      ethers.provider.send('evm_mine', [])
      const { voter } = await setup()
      await checkCurrent(ethers.provider, voter)
      console.log('')

      const terms = [...Array(4)].map((_, i) => i + 1)
      // const terms = [1, 2, 3, 4, 5]
      for await (const _t of terms) {
        console.log(`# +${_t} Term`)
        ethers.provider.send('evm_increaseTime', [TERM])
        ethers.provider.send('evm_mine', [])
        await checkCurrent(ethers.provider, voter)
        console.log('')
      }
    })
  })

  const transferLToken = async (p: {
    to: string
    minter: SignerWithAddress
    addr: string
    amount?: BigNumber
  }) => {
    const ltoken = MockLToken__factory.connect(p.addr, p.minter)
    const _amount = p.amount ?? parseEther('1')
    const tx = await ltoken.mint(p.to, _amount)
    await tx.wait()
  }

  const checkVoterStatus = async (
    voter: Voter,
    term: number,
    ltoken: string
  ) => {
    const [tokensPerWeek] = await Promise.all([
      voter.tokensPerWeek(ltoken, term),
    ])
    return tokensPerWeek
  }

  describe('check .tokensPerWeek', () => {
    const LOOP = 8
    const logVoterStatus = async (
      user: SignerWithAddress,
      voter: Voter,
      ltoken: string,
      startTerm: number,
      loop?: number
    ) => {
      const _loop = loop ?? LOOP + 1
      for (let i = 0; i < _loop; i++) {
        const _i = i + 1
        console.log(`# checkVoterStatus ${_i}`)
        logTs(startTerm + _i * TERM)
        const status = await checkVoterStatus(
          voter,
          startTerm + _i * TERM,
          ltoken
        )
        console.log(formatEther(status))
      }
      const _ltoken = MockLToken__factory.connect(ltoken, ethers.provider)
      console.log(``)

      const b = await _ltoken.balanceOf(voter.address)
      console.log(`lt#balanceOf(voter)      : ${formatEther(b)}`)

      const sb = await _ltoken.scaledBalanceOf(voter.address)
      console.log(`lt#scaledBalanceOf(voter): ${formatEther(sb)}`)

      const _claimable = await voter.connect(user).claimable()
      console.log(`voter#claimable(user)    : ${formatEther(_claimable[0])}`)
    }
    const logUserVoterStatus = async (
      lockerId: string,
      voter: Voter,
      ltoken: string,
      startTerm: number,
      loop?: number
    ) => {
      const _loop = loop ?? LOOP + 1
      for (let i = 0; i < _loop; i++) {
        const _i = i + 1
        console.log(`# checkUserVoterStatus ${_i}`)
        logTs(startTerm + _i * TERM)
        const [total, votes, poolWei] = await Promise.all([
          voter.votedTotalVotingWeights(lockerId, startTerm + _i * TERM),
          voter.votes(lockerId, ltoken, startTerm + _i * TERM),
          voter.poolWeights(ltoken, startTerm + _i * TERM),
        ])
        console.log(`votedTotalVotingWeights: ${formatEther(total)}`)
        console.log(`votes                  : ${formatEther(votes)}`)
        console.log(`poolWeights            : ${formatEther(poolWei)}`)
      }
    }

    it.only('normal cycle', async () => {
      const start = await _current(ethers.provider)
      ethers.provider.send('evm_mine', [start.term + TERM + 1 * HOUR])

      const _base = start.term + 2 * TERM + 1 * HOUR
      console.log('# Current')
      ethers.provider.send('evm_mine', [_base])
      const {
        voter,
        votingEscrow,
        oal,
        deployer,
        users: [user],
        mockLTokenAddresses: [lDAI],
      } = await setup()
      const mintParam = {
        to: voter.address,
        minter: deployer,
        addr: lDAI,
        amount: parseEther('1'),
      }

      const _createLock = async () => {
        let tx: ContractTransaction
        const AMOUNT = parseEther('0.01')
        const LOCK_DURATION = 2 * YEAR
        tx = await oal.connect(deployer).transfer(user.address, AMOUNT)
        await tx.wait()
        tx = await oal.connect(user).approve(votingEscrow.address, AMOUNT)
        await tx.wait()
        tx = await votingEscrow.connect(user).createLock(AMOUNT, LOCK_DURATION)
        await tx.wait()
      }
      const _vote = async () => {
        const weights = [1]
        const tx = await voter.connect(user).vote(weights)
        await tx.wait()
      }

      await _createLock()
      const lockerId = (await votingEscrow.ownerToId(user.address)).toString()
      console.log(`lockerId ... ${lockerId}`)
      await _vote()

      const terms = [...Array(LOOP - 3)].map((_, i) => i + 1)
      // const terms = [1, 2, 3, 4, 5]
      for await (const _t of terms) {
        console.log(`# +${_t} Term`)
        ethers.provider.send('evm_mine', [_base + _t * TERM])
        await checkCurrent(ethers.provider, voter)
        const tUnit = DAY
        let count = 0
        for (let i = 0; i < TERM - tUnit; i += tUnit) {
          ethers.provider.send('evm_increaseTime', [tUnit])
          ethers.provider.send('evm_mine', [])
          await transferLToken(mintParam)
          await (await votingEscrow.checkpoint()).wait() // ??
          await (await voter.checkpointToken()).wait()
          // await _poke()
          count++
        }
        console.log(`count = ${count}`) // 7 * parseEther(1)
        console.log('')
        await logVoterStatus(user, voter, lDAI, start.term)
        console.log('')
        console.log('')
      }
      console.log('')
      await logUserVoterStatus(lockerId, voter, lDAI, start.term)
    }).timeout(300 * 1000)

    it.only('', async () => {
      const start = await _current(ethers.provider)
      ethers.provider.send('evm_mine', [start.term + TERM + 1 * HOUR])

      console.log('■■■■■■ Current (start point to deploy)')
      const {
        voter,
        votingEscrow,
         oal,
        deployer,
        users: [user],
        mockLTokenAddresses: [lDAI],
      } = await setup() // deploy

      const mintParam = {
        to: voter.address,
        minter: deployer,
        addr: lDAI,
        amount: parseEther('1.00684565'),
      }
      const _createLock = async () => {
        let tx: ContractTransaction
        const AMOUNT = parseEther('1')
        const LOCK_DURATION = 2 * YEAR
        tx = await oal.connect(deployer).transfer(user.address, AMOUNT)
        await tx.wait()
        tx = await oal.connect(user).approve(votingEscrow.address, AMOUNT)
        await tx.wait()
        tx = await votingEscrow.connect(user).createLock(AMOUNT, LOCK_DURATION)
        await tx.wait()
      }
      const _vote = async () => {
        const weights = [1]
        const tx = await voter.connect(user).vote(weights)
        await tx.wait()
      }

      await _createLock()
      const lockerId = (await votingEscrow.ownerToId(user.address)).toString()
      await _vote()
      const _loop = 3

      console.log(`### Before transfer`)
      await (await votingEscrow.checkpoint()).wait()
      await (await voter.checkpointToken()).wait()
      console.log(`■ logVoterStatus`)
      await logVoterStatus(user, voter, lDAI, start.term, _loop)
      console.log(``)
      console.log(`■ logUserVoterStatus`)
      await logUserVoterStatus(lockerId, voter, lDAI, start.term, _loop)
      console.log(``)

      console.log(`### After transfer`)
      await transferLToken(mintParam)
      await (await votingEscrow.checkpoint()).wait()
      await (await voter.checkpointToken()).wait()
      console.log(`■ logVoterStatus`)
      await logVoterStatus(user, voter, lDAI, start.term, _loop)
      console.log(``)
      console.log(`■ logUserVoterStatus`)
      await logUserVoterStatus(lockerId, voter, lDAI, start.term, _loop)
      console.log(``)

      ethers.provider.send('evm_mine', [start.term + 2 * TERM + 1 * HOUR])
      console.log('■■■■■■ +1 TERM')
      await transferLToken(mintParam)
      await (await votingEscrow.checkpoint()).wait()
      await (await voter.checkpointToken()).wait()
      console.log(`■ logVoterStatus`)
      await logVoterStatus(user, voter, lDAI, start.term, _loop)
      console.log(``)
      console.log(`■ logUserVoterStatus`)
      await logUserVoterStatus(lockerId, voter, lDAI, start.term, _loop)

      console.log('■■■■■■ +2 TERM')
      ethers.provider.send('evm_mine', [start.term + 3 * TERM + 1 * HOUR])
      await transferLToken(mintParam)
      await (await votingEscrow.checkpoint()).wait()
      await (await voter.checkpointToken()).wait()
      console.log(`■ logVoterStatus`)
      await logVoterStatus(user, voter, lDAI, start.term, _loop)
      console.log(``)
      console.log(`■ logUserVoterStatus`)
      await logUserVoterStatus(lockerId, voter, lDAI, start.term, _loop)

      console.log('■■■■■■ after .claim')
      const tx = await voter.connect(user).claim()
      await tx.wait()
      console.log(`■ logVoterStatus`)
      await logVoterStatus(user, voter, lDAI, start.term, _loop)
    })
  })
})
