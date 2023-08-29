import { ethers, network, upgrades } from 'hardhat'
import { parseEther } from 'ethers/lib/utils'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import {
  Token,
  Token__factory,
  VotingEscrow,
  VotingEscrow__factory,
} from '../../types'

const { expect } = require('chai')

// Constants
const HOUR = 60 * 60 // in minute
const DAY = HOUR * 24
const WEEK = DAY * 7
const YEAR = DAY * 365
const TERM = 2 * WEEK

describe('ve', () => {
  let user1: SignerWithAddress
  let user2: SignerWithAddress
  let oal: Token
  let ve: VotingEscrow

  beforeEach(async () => {
    ;[user1, user2] = await ethers.getSigners()
    oal = await new Token__factory(user1).deploy(
      'OAL',
      'OAL',
      parseEther('100'),
      user1.address
    )
    await oal.deployTransaction.wait()
    ve = (await upgrades.deployProxy(new VotingEscrow__factory(user1), [
      oal.address,
    ])) as VotingEscrow
    await ve.deployTransaction.wait()
  })

  it('Creates new lock with 50 OAL for MAXTIME: The balance of user1 should increases to 1 and the balance of the VE contract should increases to 50', async () => {
    await oal.approve(ve.address, parseEther('50'))
    const lockDuration = 2 * YEAR // 2 years

    // Balance of user1 should be zero before creating the lock
    expect((await ve.ownerToId(user1.address)).toNumber()).to.equal(0)

    await ve.createLock(parseEther('50'), lockDuration)
    // Balance of the lock weight should be above 45
    expect(await ve.balanceOfLockerId(1)).to.above(parseEther('45'))
    // Owner of the lock should be user1
    expect(await ve.ownerOf(1)).to.equal(user1.address)
    // Owner of the lock should be user1
    expect((await ve.ownerToId(user1.address)).toNumber()).to.equal(1)
    // Balance of VE contract should be 50 OAL
    expect(await oal.balanceOf(ve.address)).to.be.equal(parseEther('50'))
  })

  it('User1 creates new lock for user2: The balance of user2 should increases to 1', async () => {
    await oal.approve(ve.address, parseEther('50'))
    const lockDuration = 2 * YEAR // 2 year

    // Balance of user2 should be zero before creating the lock
    expect((await ve.ownerToId(user2.address)).toNumber()).to.equal(0)

    await ve.createLockFor(parseEther('50'), lockDuration, user2.address)
    // Owner of the lock should be user2
    expect(await ve.ownerOf(1)).to.equal(user2.address)
    expect((await ve.ownerToId(user2.address)).toNumber()).to.equal(1)
  })

  it('Creating lock twice should be reverted', async () => {
    await oal.approve(ve.address, parseEther('50'))
    const lockDuration = 2 * YEAR // 2 years

    // Balance of user2 should be zero before creating the lock
    expect((await ve.ownerToId(user1.address)).toNumber()).to.equal(0)

    await ve.createLock(parseEther('50'), lockDuration)
    // Balance of user1 should be 1 after creating the lock
    expect((await ve.ownerToId(user1.address)).toNumber()).to.equal(1)
    // User can not hold more than 1 ID
    await expect(ve.createLock(parseEther('50'), lockDuration)).to.be.reverted
  })

  it('Creating lock with 0 OAL should be reverted', async () => {
    await oal.approve(ve.address, parseEther('50'))
    const lockDuration = 2 * YEAR // 2 years
    await expect(ve.createLock(parseEther('0'), lockDuration)).to.be.reverted
  })

  it('Creating lock with zero lock duration should be reverted', async () => {
    await oal.approve(ve.address, parseEther('50'))
    await expect(ve.createLock(parseEther('50'), 0)).to.be.reverted
  })

  it('Creates lock with a lock duration more than MAXTIME should be reverted', async () => {
    await oal.approve(ve.address, parseEther('50'))
    await expect(ve.createLock(parseEther('50'), 2 * YEAR + TERM)).to.be
      .reverted
  })

  it('Increases lock amount to 100 OAL after creating new lock with 50 OAL for MAXTIME: The balance of the lock weight should increase', async () => {
    const lockDuration = 2 * YEAR // 2 years
    await oal.approve(ve.address, parseEther('100'))

    await ve.createLock(parseEther('50'), lockDuration)
    // Balance of the lock weight should be below 55
    expect(await ve.balanceOfLockerId(1)).to.be.below(parseEther('55'))
    // Balance of the lock weight should be above 45
    expect(await ve.balanceOfLockerId(1)).to.be.above(parseEther('45'))

    await ve.increaseAmount(parseEther('50'))
    // Balance of the lock weight should be above 95
    expect(await ve.balanceOfLockerId(1)).to.be.above(parseEther('95'))
    expect(await oal.balanceOf(ve.address)).to.be.equal(parseEther('100'))
  })

  it('User1 deposits 50 OAL for user2 after user2 creates new lock with 50 OAL for MAXTIME: The balance of the lock weight should increase by depositing of user1', async () => {
    await oal.approve(ve.address, parseEther('100'))
    await oal.transfer(user2.address, parseEther('50'))
    await oal.connect(user2).approve(ve.address, parseEther('50'))
    const lockDuration = 2 * YEAR // 2 years

    await ve.connect(user2).createLock(parseEther('50'), lockDuration)
    // Owner of the lock should be user2
    expect(await ve.ownerOf(1)).to.equal(user2.address)
    expect((await ve.ownerToId(user2.address)).toString()).to.equal('1')
    // Balance of the lock weight should be below 55
    expect(await ve.balanceOfLockerId(1)).to.below(parseEther('55'))
    // Balance of the lock weight should be above 45
    expect(await ve.balanceOfLockerId(1)).to.above(parseEther('45'))

    await ve.connect(user1).depositFor(user2.address, parseEther('50'))
    // Balance of the lock weight should be above 95
    expect(await ve.balanceOfLockerId(1)).to.above(parseEther('95'))
  })

  it('Increasing lock amount without existing lock should be reverted', async () => {
    await oal.approve(ve.address, parseEther('50'))

    await expect(ve.increaseAmount(parseEther('50'))).to.be.reverted
  })

  it('Increasing lock amount to expired lock should be reverted', async () => {
    const lockDuration = 2 * YEAR // 2 years
    await oal.approve(ve.address, parseEther('100'))

    await ve.createLock(parseEther('50'), lockDuration)
    await network.provider.send('evm_increaseTime', [lockDuration])
    await network.provider.send('evm_mine')
    await expect(ve.increaseAmount(parseEther('50'))).to.be.reverted
  })

  it('Increase unlock time from 1 year to two years: The unlock time should be extended', async () => {
    await oal.approve(ve.address, parseEther('50'))
    const OneYear = 1 * YEAR // 1 year

    await ve.createLock(parseEther('50'), OneYear)
    await ve.increaseUnlockTime(OneYear + TERM)
    await network.provider.send('evm_increaseTime', [OneYear])
    await network.provider.send('evm_mine')
    // Owner of the lock should be still user1 if it's not expired
    expect(await ve.ownerOf(1)).to.equal(user1.address)
    expect((await ve.ownerToId(user1.address)).toString()).to.equal('1')
  })

  it('Decreasing unlock time should be reverted', async () => {
    await oal.approve(ve.address, parseEther('50'))
    const OneYear = 1 * YEAR // 2 year
    const TwoYears = 2 * YEAR // 2 year

    await ve.createLock(parseEther('50'), TwoYears)
    await expect(ve.increaseUnlockTime(OneYear)).to.be.reverted
  })

  it('Increasing unlock time of a expired lock should be reverted', async () => {
    await oal.approve(ve.address, parseEther('50'))
    const OneYear = 1 * YEAR // 1 year

    await ve.createLock(parseEther('50'), OneYear)
    await network.provider.send('evm_increaseTime', [OneYear])
    await network.provider.send('evm_mine')
    await expect(ve.increaseUnlockTime(OneYear)).to.be.reverted
  })

  it('Withdrawing before the time has expired should be reverted', async () => {
    await oal.approve(ve.address, parseEther('50'))
    const lockDuration = 2 * YEAR // 2 years

    await ve.createLock(parseEther('50'), lockDuration)

    // Try withdraw early
    await expect(ve.withdraw()).to.be.reverted
  })

  it('Withdraws: The deposited amount should be fully withdrawn and locker ID should be burnt', async () => {
    await oal.approve(ve.address, parseEther('50'))
    const lockDuration = 2 * YEAR // 2 years

    await ve.createLock(parseEther('50'), lockDuration)

    // Withdraw after the time has expired
    ethers.provider.send('evm_increaseTime', [lockDuration])
    ethers.provider.send('evm_mine', []) // mine the next block
    await ve.withdraw()

    // The balance of OAL of user1 should be equal to initial amount
    expect(await oal.balanceOf(user1.address)).to.equal(parseEther('100'))
    // Check that the LockerId is burnt
    expect(await ve.balanceOfLockerId(1)).to.equal(0)
    expect(await ve.ownerOf(1)).to.equal(ethers.constants.AddressZero)
    expect((await ve.ownerToId(user1.address)).toString()).to.equal('0')
  })
})
