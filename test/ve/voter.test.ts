import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { parseEther } from 'ethers/lib/utils'
import { network, upgrades } from 'hardhat'
import {
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
  let usdcpool: SignerWithAddress
  let daipool: SignerWithAddress
  let usdtpool: SignerWithAddress
  let lendingPool: MockLendingPool
  before(async () => {
    ;[
      user1,
      user2,
      user3,
      user4,
      user5,
      distributor,
      usdcpool,
      daipool,
      usdtpool,
    ] = await ethers.getSigners()
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

  // it('Sets a additional pool: The number of pools should be increased by one after excuting addPool()', async () => {
  //   const token = lusdt.address
  //   const wrongPool = usdcpool.address
  //   await vevoter.connect(distributor).addPool(token, wrongPool)
  // })

  // it('Updates a wrong pool', async () => {
  //   const token = lusdt.address
  //   const pool = usdtpool.address
  //   await vevoter.connect(distributor).updatePool(token, pool)
  // })

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

  it('Distribute 100 OAL to user1', async () => {
    // Sets voting weight of user1 ([lusdc, ldai, lusdt])
    let weight = [1, 1, 0]
    // User1 votes veOAL whose locker ID is 1 according to the voting weight
    await vevoter.connect(user1).vote(weight)

    // The Vote will be reflected at the next weekly checkpoint
    // so it is sufficient if at least one week has passed since the vote
    await waitWeek(7)

    // The fees 1 lUSDC and 1 lDAI are minted 100 times every 2 hours
    // and user1 also claim 100 times every 2 hours
    for (let i = 0; i < 100; i++) {
      await lusdc.mintToTreasury(vevoter.address, parseEther('1'))
      await ldai.mintToTreasury(vevoter.address, parseEther('1'))
      await network.provider.send('evm_increaseTime', [2 * HOUR])
      await network.provider.send('evm_mine')
      await vevoter.connect(user1).claim()
    }

    // User1 claim again a week after the last mint and receive all fees
    await waitWeek(7)
    await vevoter.connect(user1).claim()
    console.log(
      'balance of lusdc at user1 address is %s',
      await lusdc.balanceOf(user1.address)
    )
    console.log(
      'balance of ldai at user1 address is %s',
      await ldai.balanceOf(user1.address)
    )
    console.log(
      'balance of lusdc at vevoter address is %s',
      await lusdc.balanceOf(vevoter.address)
    )
    console.log(
      'balance of ldai at vevoter address is %s',
      await ldai.balanceOf(vevoter.address)
    )
  })

  it('reset voting', async () => {
    expect(await ve.isVoted(1)).to.be.equal(true)
    await vevoter.connect(user1).reset()
    expect(await ve.isVoted(1)).to.be.equal(false)
  })

  it('Distribute fees to user1, user2, and user3 with same voting weight: The distibuted fees should be the same amount for the users', async () => {
    let weight2 = [1, 1, 0]
    let weight3 = [1, 1, 0]
    let weight4 = [1, 1, 0]
    await vevoter.connect(user2).vote(weight2)
    await vevoter.connect(user3).vote(weight3)
    await vevoter.connect(user4).vote(weight4)

    // The Vote will be reflected at the next weekly checkpoint
    // so it is sufficient if at least one week has passed since the vote
    await network.provider.send('evm_increaseTime', [5 * WEEK])
    await network.provider.send('evm_mine')

    // 100 lUSDC and 100 lDAI are minted to Voter contract
    await lusdc.mintToTreasury(vevoter.address, parseEther('100'))
    await ldai.mintToTreasury(vevoter.address, parseEther('100'))

    // User2, user3, and user4 will claim at the differnt time
    await vevoter.checkpointToken()
    await waitWeek()
    await vevoter.checkpointToken()
    await waitWeek()
    await vevoter.connect(user2).claim()
    await waitWeek(5)
    await vevoter.connect(user3).claim()
    await waitWeek(5)
    await vevoter.connect(user4).claim()
    await waitWeek(5)

    console.log(
      'balance of lusdc at user2 address is %s',
      await lusdc.balanceOf(user2.address)
    )
    console.log(
      'balance of ldai  at user2 address is %s',
      await ldai.balanceOf(user2.address)
    )
    console.log(
      'balance of lusdc at user3 address is %s',
      await lusdc.balanceOf(user3.address)
    )
    console.log(
      'balance of ldai  at user3 address is %s',
      await ldai.balanceOf(user3.address)
    )
    console.log(
      'balance of lusdc at user4 address is %s',
      await lusdc.balanceOf(user4.address)
    )
    console.log(
      'balance of ldai  at user4 address is %s',
      await ldai.balanceOf(user4.address)
    )
    console.log(
      'balance of lusdc at vevoter address is %s',
      await lusdc.balanceOf(vevoter.address)
    )
    console.log(
      'balance of ldai at vevoter address is %s',
      await ldai.balanceOf(vevoter.address)
    )
  })

  it('Check the end of vote period', async () => {
    let weight5 = [1, 1, 0]
    let lockerId = await ve.ownerToId(user5.address)
    await waitWeek()

    const oneDay = 1 * DAY
    const oneTerm = 7 * DAY * 2
    const fourWeeks = 4 * WEEK
    const halfYear = 6 * fourWeeks
    const oneYear = 1 * YEAR
    const lockEndtime = (await ve.lockedEnd(lockerId)).toNumber()

    const blockNum = await ethers.provider.getBlockNumber()
    const block = await ethers.provider.getBlock(blockNum)
    const currentTimestamp = block.timestamp

    let roundedTimestamp = Math.floor(currentTimestamp / oneTerm) * oneTerm
    let roundedOneDay =
      Math.floor((currentTimestamp + oneDay) / oneTerm) * oneTerm
    let roundedOneWeek =
      Math.floor((currentTimestamp + oneTerm) / oneTerm) * oneTerm
    let roundedFourWeeks =
      Math.floor((currentTimestamp + fourWeeks) / oneTerm) * oneTerm
    let roundedHalfYear =
      Math.floor((currentTimestamp + halfYear) / oneTerm) * oneTerm
    let roundedOneYear =
      Math.floor((currentTimestamp + oneYear) / oneTerm) * oneTerm
    let roundedLockEndtime = Math.floor(lockEndtime / oneTerm) * oneTerm

    const consoleLogTimestamp = (timestamp: number) =>
      console.log(`${new Date(timestamp * 1000).toISOString()} (${timestamp})`)
    ;[
      roundedTimestamp,
      roundedOneDay,
      roundedOneWeek,
      roundedFourWeeks,
      roundedHalfYear,
      roundedOneYear,
      roundedLockEndtime,
    ].forEach(consoleLogTimestamp)

    /// case1: vote period is OneDay

    await expect(
      vevoter.connect(user5).voteUntil(weight5, currentTimestamp + oneDay)
    ).to.be.reverted

    /// case2: vote period is oneTerm
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

    console.log(
      'votes at roundedOneWeek is %s',
      await vevoter.votes(lockerId, lusdc.address, roundedOneWeek)
    )
    console.log(
      'votedTotalVotingWeights at roundedOneWeek is %s',
      await vevoter.votedTotalVotingWeights(lockerId, roundedOneWeek)
    )

    await expect(
      await vevoter.votes(lockerId, lusdc.address, roundedOneWeek + oneTerm)
    ).to.be.equal(0)
    await expect(
      await vevoter.votedTotalVotingWeights(lockerId, roundedOneWeek + oneTerm)
    ).to.be.equal(0)

    /// case3: vote period is FourWeeks
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

    console.log(
      'votes at roundedFourWeeks is %s',
      await vevoter.votes(lockerId, lusdc.address, roundedFourWeeks)
    )
    console.log(
      'votedTotalVotingWeights at roundedFourWeeks is %s',
      await vevoter.votedTotalVotingWeights(lockerId, roundedFourWeeks)
    )

    await expect(
      await vevoter.votes(lockerId, lusdc.address, roundedFourWeeks + oneTerm)
    ).to.be.equal(0)
    await expect(
      await vevoter.votedTotalVotingWeights(
        lockerId,
        roundedFourWeeks + oneTerm
      )
    ).to.be.equal(0)

    /// case4: vote period is OneYear
    await expect(
      vevoter.connect(user5).voteUntil(weight5, currentTimestamp + oneYear)
    ).to.be.revertedWith('Over max vote end timestamp')

    /// case5: the end of vote period is LockEndtime
    await expect(
      vevoter.connect(user5).voteUntil(weight5, lockEndtime)
    ).to.be.revertedWith('Over max vote end timestamp')
  })
  it('suspend token', async () => {
    await vevoter.connect(user1).vote([1, 1, 0])
    await vevoter.connect(distributor).suspendToken(lusdc.address)
    await expect(vevoter.connect(user1).vote([1, 1, 0])).to.be.revertedWith(
      'Must be the same length: tokens, _weight'
    )
  })
})

const waitWeek = async (weeks?: number) => {
  await network.provider.send('evm_increaseTime', [weeks ? weeks : 1 * WEEK])
  await network.provider.send('evm_mine')
}
