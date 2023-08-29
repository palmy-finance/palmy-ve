import { expect } from 'chai'
import { BigNumber } from 'ethers'
import { parseEther } from 'ethers/lib/utils'
import { ethers, upgrades } from 'hardhat'
import {
  Token__factory,
  VotingEscrow,
  VotingEscrowV2,
  VotingEscrowV2__factory,
  VotingEscrow__factory,
} from '../../types'
import { getCurrentTerm, multiTransferOal, TERM, YEAR } from './utils'

// Prepare
const setup = async () => {
  const [deployer, ...rest] = await ethers.getSigners()
  const oal = await new Token__factory(deployer).deploy(
    'OAL',
    'OAL',
    parseEther('9999999'),
    deployer.address
  )
  await oal.deployTransaction.wait()
  const _votingEscrow = (await upgrades.deployProxy(
    new VotingEscrow__factory(deployer),
    [oal.address]
  )) as VotingEscrow
  await _votingEscrow.deployTransaction.wait()
  const _upgradedVotingEscrow = (await upgrades.upgradeProxy(
    _votingEscrow,
    new VotingEscrowV2__factory(deployer),
    { call: { fn: 'initializeV2' } }
  )) as VotingEscrowV2
  await _upgradedVotingEscrow.deployTransaction.wait()

  return {
    deployer,
    users: rest,
    oal,
    votingEscrow: _upgradedVotingEscrow,
  }
}

describe('VotingEscrowV2.sol', () => {
  const _setup = async (oal?: { amount: BigNumber; count: number }) => {
    const results = await setup()
    await multiTransferOal({
      users: results.users,
      length: oal ? oal.count : 5,
      amount: oal ? oal.amount : parseEther('100'),
      oal: results.oal,
      holder: results.deployer,
    })
    return results
  }

  it('initialize by .initializeV2', async () => {
    const { votingEscrow } = await _setup()
    const version = await votingEscrow.version()
    expect(version).to.eq('2.0.0')
  })

  describe('.createLock, .createLockFor', () => {
    const __setup = async () => {
      const amount = parseEther('100')
      const NUM_OF_USERS = 3
      const { deployer, users, oal, votingEscrow } = await _setup({
        amount: amount,
        count: NUM_OF_USERS,
      })
      const _users = users.splice(0, NUM_OF_USERS)

      const tx = await oal
        .connect(deployer)
        .approve(votingEscrow.address, amount)
      await tx.wait()
      for await (const _user of _users) {
        const tx = await oal
          .connect(_user)
          .approve(votingEscrow.address, amount)
        await tx.wait()
      }
      // Proceed next term
      const currentTerm = await getCurrentTerm()
      ethers.provider.send('evm_mine', [currentTerm + TERM])

      return {
        votingEscrow: votingEscrow,
        deployer,
        users: _users,
      }
    }
    it('fail: already exist lock', async () => {
      const { votingEscrow: ve, deployer, users } = await __setup()
      const [userA, userB, userC] = users

      await (await ve.connect(userA).createLock('1', 2 * YEAR)).wait()
      await (
        await ve.connect(deployer).createLockFor('1', 2 * YEAR, userB.address)
      ).wait()
      expect((await ve.ownerToId(userA.address)).toNumber()).to.eq(1)
      expect((await ve.ownerToId(userB.address)).toNumber()).to.eq(2)
      expect((await ve.ownerToId(userC.address)).toNumber()).to.eq(0)

      // about .createLock
      await expect(ve.connect(userA).createLock('1', 2 * YEAR)).to.revertedWith(
        '_to already has locker id'
      )
      await expect(ve.connect(userB).createLock('1', 2 * YEAR)).to.revertedWith(
        '_to already has locker id'
      )

      // about .createLockFor
      await expect(
        ve.connect(deployer).createLockFor('1', 2 * YEAR, userA.address)
      ).to.revertedWith('_to already has locker id')
      await expect(
        ve.connect(deployer).createLockFor('1', 2 * YEAR, userB.address)
      ).to.revertedWith('_to already has locker id')

      // Check: not affect to existing lock
      await (await ve.connect(userC).createLock('1', 2 * YEAR)).wait()
      expect((await ve.ownerToId(userA.address)).toNumber()).to.eq(1)
      expect((await ve.ownerToId(userB.address)).toNumber()).to.eq(2)
      expect((await ve.ownerToId(userC.address)).toNumber()).to.eq(3)
    })
  })

  describe('.latestLockerId, .getOwnerFromLockerId, .getAllLockerIdAndOwner', () => {
    const __setup = async () => {
      const amount = parseEther('100')
      const NUM_OF_USERS = 5
      const { deployer, users, oal, votingEscrow } = await _setup({
        amount: amount,
        count: NUM_OF_USERS,
      })
      const _users = users.splice(0, NUM_OF_USERS)

      const tx = await oal
        .connect(deployer)
        .approve(votingEscrow.address, amount)
      await tx.wait()
      for await (const _user of _users) {
        const tx = await oal
          .connect(_user)
          .approve(votingEscrow.address, amount)
        await tx.wait()
      }

      return {
        votingEscrow: votingEscrow,
        deployer,
        users: _users,
      }
    }

    it('scenario', async () => {
      const { votingEscrow: ve, deployer, users } = await __setup()
      const [userA, userB, userC, userD, userE] = users

      expect((await ve.latestLockerId()).toNumber()).to.eq(0)

      await (await ve.connect(userA).createLock('1', 2 * YEAR)).wait()
      await (await ve.connect(userB).createLock('1', 2 * YEAR)).wait()
      await (await ve.connect(userC).createLock('1', 2 * YEAR)).wait()
      await (await ve.connect(userD).createLock('1', 2 * YEAR)).wait()
      await (await ve.connect(userE).createLock('1', 2 * YEAR)).wait()

      expect((await ve.latestLockerId()).toNumber()).to.eq(5)
      const _all = await ve.getAllLockerIdAndOwner()
      expect(_all[0].id.toNumber()).eq(1)
      expect(_all[0].owner).eq(userA.address)
      expect(_all[1].id.toNumber()).eq(2)
      expect(_all[1].owner).eq(userB.address)
      expect(_all[2].id.toNumber()).eq(3)
      expect(_all[2].owner).eq(userC.address)
      expect(_all[3].id.toNumber()).eq(4)
      expect(_all[3].owner).eq(userD.address)
      expect(_all[4].id.toNumber()).eq(5)
      expect(_all[4].owner).eq(userE.address)
    })
  })
})
