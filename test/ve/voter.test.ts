import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { parseEther } from 'ethers/lib/utils'
import { network, upgrades } from 'hardhat'
import {
  LToken,
  MockLToken,
  MockLToken__factory,
  MockLendingPool,
  MockLendingPool__factory,
  Token,
  Token__factory,
  Voter,
  Voter__factory,
  VotingEscrow,
  VotingEscrow__factory,
} from '../../types'
import { BigNumber } from 'ethers'
const { expect } = require('chai')
const { ethers } = require('hardhat')

// Constants
const HOUR = 60 * 60 // in minute
const DAY = HOUR * 24
const WEEK = DAY * 7
const YEAR = DAY * 365

describe('voter', () => {
  let lusdc: MockLToken
  let ldai: MockLToken
  let lusdt: MockLToken
  let oal: Token
  let ve: VotingEscrow
  let vevoter: Voter
  let user1: SignerWithAddress
  let user2: SignerWithAddress
  let user3: SignerWithAddress
  let user4: SignerWithAddress
  let user5: SignerWithAddress
  let distributor: SignerWithAddress
  let lendingPool: MockLendingPool
  const setup = async () => {
    ;[user1, user2, user3, user4, user5, distributor] =
      await ethers.getSigners()
    const ltokenFactory = new MockLToken__factory(distributor)

    lusdc = await ltokenFactory.deploy('LUSDC', 'LUSDC')
    ldai = await ltokenFactory.deploy('LDAI', 'LDAI')
    lusdt = await ltokenFactory.deploy('LUSDT', 'LUSDT')
    await lusdc.deployTransaction.wait()
    await ldai.deployTransaction.wait()
    await lusdt.deployTransaction.wait()

    oal = await new Token__factory(user1).deploy(
      'OAL',
      'OAL',
      parseEther('500'),
      distributor.address
    )
    await oal.deployTransaction.wait()
    const oalInstance = oal.connect(distributor)
    for (const user of [user1, user2, user3, user4, user5]) {
      await oalInstance.transfer(user.address, parseEther('100'))
    }
    ve = (await upgrades.deployProxy(new VotingEscrow__factory(distributor), [
      oal.address,
    ])) as VotingEscrow
    await ve.deployTransaction.wait()
    lendingPool = await new MockLendingPool__factory(distributor).deploy()
    vevoter = (await upgrades.deployProxy(new Voter__factory(distributor), [
      lendingPool.address,
      ve.address,
    ])) as Voter
    await vevoter.deployTransaction.wait()
  }

  const mintToTreasury = async (token: MockLToken, amount: BigNumber) => {
    await mintLToken(token, vevoter.address, amount)
  }

  const mintLToken = async (
    token: MockLToken,
    to: string,
    amount: BigNumber
  ) => {
    await token.mint(to, amount)
  }

  before(async () => {
    await setup()
  })

  it('User1, user2, user3, user4, and user5 create new lock by locking 100 OAL for MAXTIME', async () => {
    let TwoYears = 2 * YEAR
    await oal.connect(user1).approve(ve.address, parseEther('100'))
    await oal.connect(user2).approve(ve.address, parseEther('100'))
    await oal.connect(user3).approve(ve.address, parseEther('100'))
    await oal.connect(user4).approve(ve.address, parseEther('100'))
    await oal.connect(user5).approve(ve.address, parseEther('100'))

    await ve.connect(user1).createLock(parseEther('100'), TwoYears)
    await ve.connect(user2).createLock(parseEther('100'), TwoYears)
    await ve.connect(user3).createLock(parseEther('100'), TwoYears)
    await ve.connect(user4).createLock(parseEther('100'), TwoYears)
    await ve.connect(user5).createLock(parseEther('100'), TwoYears)

    expect(await oal.balanceOf(ve.address)).to.be.equal(parseEther('500'))
  })

  it('Sets voter: voter should be Voter contract', async () => {
    await ve.connect(distributor).setVoter(vevoter.address)
    expect(await ve.voter()).to.be.equal(vevoter.address)
  })

  it('Sets the pools that can be voted: Setting pools twice should be reverted', async () => {
    let tokens = [lusdc.address, ldai.address]
    // let pools = [usdcpool.address, daipool.address]
    await vevoter.connect(distributor).addToken(tokens[0])
    await vevoter.connect(distributor).addToken(tokens[1])
    await expect(
      vevoter.connect(distributor).addToken(tokens[1])
    ).to.be.revertedWith('Already whitelisted')

    await vevoter.connect(distributor).addToken(lusdt.address)
  })

  it('Confirm that the pools and the tokens are set correctly', async () => {
    expect(await vevoter.pools(lusdc.address)).to.be.equal(lusdc.address)
    expect(await vevoter.pools(ldai.address)).to.be.equal(ldai.address)
    expect(await vevoter.pools(lusdt.address)).to.be.equal(lusdt.address)
  })

  it('Should be reverted if the number of given weights do not match the number of pools', async () => {
    let weight = [1, 1]
    await expect(vevoter.connect(user1).vote(weight)).to.be.revertedWith(
      'Must be the same length: tokens, _weight'
    )
  })

  it('claim', async () => {
    // Sets voting weight of user1 ([lusdc, ldai, lusdt])
    let weight = [1, 1, 0]
    // User1 votes veOAL whose locker ID is 1 according to the voting weight
    await vevoter.connect(user1).vote(weight)

    // The Vote will be reflected at the next term checkpoint
    // so it is sufficient if at least one term has passed since the vote
    await waitTerm()

    // The fees 1 lUSDC and 1 lDAI are minted 100 times every 2 hours
    // and user1 also claim 100 times every 2 hours
    for (let i = 0; i < 100; i++) {
      await mintToTreasury(lusdc, parseEther('1'))
      await mintToTreasury(ldai, parseEther('1'))
      await vevoter.connect(user1).claim()
      await waitFor(2 * HOUR)
    }

    // User1 claim again a week after the last mint and receive almost all the fees
    await waitTerm()
    await vevoter.connect(user1).claim()
    await expect(await lusdc.balanceOf(user1.address)).to.be.above(
      parseEther('99')
    )
    await expect(await ldai.balanceOf(user1.address)).to.be.above(
      parseEther('99')
    )
    await expect(await lusdc.balanceOf(vevoter.address)).to.be.lt(
      parseEther('1')
    )
    await expect(await ldai.balanceOf(vevoter.address)).to.be.lt(
      parseEther('1')
    )
  })

  it('reset voting', async () => {
    expect(await ve.isVoted(1)).to.be.equal(true)
    await vevoter.connect(user1).reset()
    expect(await ve.isVoted(1)).to.be.equal(false)
  })

  it('Distribute fees to user1, user2, and user3 with same voting weight: The distibuted fees should be the same amount for the users', async () => {
    let weight = [1, 1, 0]
    await vevoter.connect(user2).vote(weight)
    await vevoter.connect(user3).vote(weight)
    await vevoter.connect(user4).vote(weight)

    // The Vote will be reflected at the next weekly checkpoint
    // so it is sufficient if at least one week has passed since the vote
    await network.provider.send('evm_increaseTime', [5 * WEEK])
    await network.provider.send('evm_mine')

    // 100 lUSDC and 100 lDAI are minted to Voter contract
    await mintToTreasury(lusdc, parseEther('100'))
    await mintToTreasury(ldai, parseEther('100'))

    // User2, user3, and user4 will claim at the differnt time
    await vevoter.checkpointToken()
    await waitTerm(2)
    await vevoter.checkpointToken()
    await waitWeek()
    await vevoter.connect(user2).claim()
    await waitWeek(5)
    await vevoter.connect(user3).claim()
    await waitWeek(5)
    await vevoter.connect(user4).claim()
    await waitWeek(5)

    const balances = await Promise.all([
      lusdc.balanceOf(user2.address),
      ldai.balanceOf(user2.address),
      lusdc.balanceOf(user3.address),
      ldai.balanceOf(user3.address),
      lusdc.balanceOf(user4.address),
      ldai.balanceOf(user4.address),
    ])
    for (const balance of balances) {
      if (balances.indexOf(balance) == balances.length - 1) {
        continue
      }
      const next = balances[balances.indexOf(balance) + 1]
      await expect(balance).to.be.equal(next)
    }
  })

  it('Check the end of vote period', async () => {
    let weight5 = [1, 1, 0]
    let lockerId = await ve.ownerToId(user5.address)
    await waitWeek()

    const oneTerm = 7 * DAY * 2
    const fourWeeks = 4 * WEEK
    const oneYear = 1 * YEAR
    const lockEndtime = (await ve.lockedEnd(lockerId)).toNumber()

    const blockNum = await ethers.provider.getBlockNumber()
    const block = await ethers.provider.getBlock(blockNum)
    const currentTimestamp = block.timestamp

    let roundedOneWeek =
      Math.floor((currentTimestamp + oneTerm) / oneTerm) * oneTerm
    let roundedFourWeeks =
      Math.floor((currentTimestamp + fourWeeks) / oneTerm) * oneTerm
    // case1: vote period is oneTerm
    await vevoter.connect(user5).voteUntil(weight5, currentTimestamp + oneTerm)
    await expect(await vevoter.voteEndTime(lockerId)).to.be.equal(
      currentTimestamp + oneTerm
    )

    await expect(
      await vevoter.votes(lockerId, lusdc.address, roundedOneWeek)
    ).to.be.above(0)
    await expect(
      await vevoter.votedTotalVotingWeights(lockerId, roundedOneWeek)
    ).to.be.above(0)

    await expect(
      await vevoter.votes(lockerId, lusdc.address, roundedOneWeek + oneTerm)
    ).to.be.equal(0)
    await expect(
      await vevoter.votedTotalVotingWeights(lockerId, roundedOneWeek + oneTerm)
    ).to.be.equal(0)

    // case2: vote period is FourWeeks
    await vevoter
      .connect(user5)
      .voteUntil(weight5, currentTimestamp + fourWeeks)
    await expect(await vevoter.voteEndTime(lockerId)).to.be.equal(
      currentTimestamp + fourWeeks
    )

    await expect(
      await vevoter.votes(lockerId, lusdc.address, roundedFourWeeks)
    ).to.be.above(0)
    await expect(
      await vevoter.votedTotalVotingWeights(lockerId, roundedFourWeeks)
    ).to.be.above(0)

    await expect(
      await vevoter.votes(lockerId, lusdc.address, roundedFourWeeks + oneTerm)
    ).to.be.equal(0)
    await expect(
      await vevoter.votedTotalVotingWeights(
        lockerId,
        roundedFourWeeks + oneTerm
      )
    ).to.be.equal(0)

    // case3: vote period is OneYear
    await expect(
      vevoter.connect(user5).voteUntil(weight5, currentTimestamp + oneYear)
    ).to.be.revertedWith('Over max vote end timestamp')

    // case4: the end of vote period is LockEndtime
    await expect(
      vevoter.connect(user5).voteUntil(weight5, lockEndtime)
    ).to.be.revertedWith('Over max vote end timestamp')

    // case5: vote period is this term
    await expect(
      vevoter.connect(user5).voteUntil(weight5, currentTimestamp)
    ).to.be.revertedWith("Can't vote for the past")
  })
  it('suspend token', async () => {
    await vevoter.connect(user1).vote([1, 1, 0])
    await vevoter.connect(distributor).suspendToken(lusdc.address)
    await expect(vevoter.connect(user1).vote([1, 1, 0])).to.be.revertedWith(
      'Must be the same length: tokens, _weight'
    )
  })
  describe('distribution amount', async () => {
    const _setUp = async () => {
      await setup()
      await ve.setVoter(vevoter.address)
      await vevoter.connect(distributor).addToken(lusdc.address)
    }
    it('if total reward is 10USDC, then user can claim 10', async () => {
      await _setUp()
      const reward = parseEther('10')
      await oal.connect(user1).approve(ve.address, parseEther('1'))
      await ve.connect(user1).createLock(parseEther('1'), 2 * YEAR)
      await vevoter.connect(user1).vote([1])
      // vote is valid after 1 term
      await waitTerm()
      await vevoter.checkpointToken()
      await mintToTreasury(lusdc, reward)
      await vevoter.checkpointToken()
      await waitTerm()
      await vevoter.checkpointToken()
      await expect((await vevoter.connect(user1).claimable())[0]).to.be.equal(
        reward
      )
    })
    it('if total reward is 10 USDC and liquidity index grows 1.5 times after checkpoint, then user can claim 15', async () => {
      await _setUp()
      const reward = parseEther('10')
      const multiplier = (a: BigNumber) => a.mul('15').div('10')
      await oal.connect(user1).approve(ve.address, parseEther('1'))
      await ve.connect(user1).createLock(parseEther('1'), 2 * YEAR)
      await vevoter.connect(user1).vote([1])
      // vote is valid after 1 term
      await waitTerm()
      await vevoter.checkpointToken()
      await mintToTreasury(lusdc, reward)
      await vevoter.checkpointToken()
      await waitTerm()
      await vevoter.checkpointToken()
      // liquidity index grows 1.5 times
      await lusdc.setIndex(multiplier(await lusdc.index()))
      await expect((await vevoter.connect(user1).claimable())[0]).to.be.equal(
        multiplier(reward)
      )
    })
  })
})

const waitTerm = async (terms?: number) => {
  await waitWeek((terms || 1) * 2)
}

const waitWeek = async (weeks?: number) => {
  const count = weeks || 1
  await waitFor(count * WEEK)
}

const waitFor = async (seconds: number) => {
  await network.provider.send('evm_increaseTime', [seconds])
  await network.provider.send('evm_mine')
}
