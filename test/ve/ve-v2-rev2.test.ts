import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { ContractTransaction } from 'ethers'
import { formatEther, parseEther } from 'ethers/lib/utils'
import { ethers, upgrades } from 'hardhat'
import {
  Token__factory,
  VotingEscrow,
  VotingEscrowV2,
  VotingEscrowV2Rev2,
  VotingEscrowV2Rev2__factory,
  VotingEscrowV2__factory,
  VotingEscrow__factory,
} from '../../types'
import { multiTransferOal, YEAR } from './utils'

// Prepare
const deployVeV1 = async (
  deployer: SignerWithAddress,
  oal: string
): Promise<VotingEscrow> => {
  const _ve = (await upgrades.deployProxy(new VotingEscrow__factory(deployer), [
    oal,
  ])) as VotingEscrow
  await _ve.deployTransaction.wait()
  return _ve
}
const upgradeToV2 = async (
  deployer: SignerWithAddress,
  ve: VotingEscrow
): Promise<VotingEscrowV2> => {
  const _veV2 = (await upgrades.upgradeProxy(
    ve.address,
    new VotingEscrowV2__factory(deployer),
    { call: { fn: 'initializeV2' } }
  )) as VotingEscrowV2
  await _veV2.deployTransaction.wait()
  return _veV2
}
const upgradeToV2Rev2 = async (
  deployer: SignerWithAddress,
  ve: VotingEscrowV2
): Promise<VotingEscrowV2Rev2> => {
  const _veV2Rev2 = (await upgrades.upgradeProxy(
    ve.address,
    new VotingEscrowV2Rev2__factory(deployer),
    { call: { fn: 'initializeV2Rev2' } }
  )) as VotingEscrowV2Rev2
  await _veV2Rev2.deployTransaction.wait()
  return _veV2Rev2
}

const setup = async () => {
  const [deployer, ...rest] = await ethers.getSigners()
  const oal = await new Token__factory(deployer).deploy(
    'OAL',
    'OAL',
    parseEther('9999999'),
    deployer.address
  )
  await oal.deployTransaction.wait()

  return {
    deployer,
    users: rest,
     oal,
  }
}

describe('VotingEscrowV2Rev2.sol', () => {
  it('initialize by .initializeV2Rev2', async () => {
    const { deployer, oal } = await setup()
    const veV1 = await deployVeV1(deployer, oal.address)
    const veV2 = await upgradeToV2(deployer, veV1)
    const veV2Rev2 = await upgradeToV2Rev2(deployer, veV2)

    const version = await veV2Rev2.version()
    expect(version).to.eq('2.0.1')
  })

  describe('.withdrawEmergency', () => {
    it('normal', async () => {
      const AMOUNT = parseEther('100')
      const { deployer, users, oal } = await setup()
      const NUM_OF_USERS = 4
      const _users = users.splice(0, NUM_OF_USERS)
      const [userA, userB, userC, userD] = _users
      const ZERO_ADDRESS = ethers.constants.AddressZero

      // in V1
      const veV1 = await deployVeV1(deployer, oal.address)
      //// Prepare
      await multiTransferOal({
        users: _users,
        length: NUM_OF_USERS,
        amount: AMOUNT,
        oal,
        holder: deployer,
      })
      for await (const _user of [deployer, ..._users]) {
        const tx = await oal.connect(_user).approve(veV1.address, AMOUNT)
        await tx.wait()
      }
      //// old lock (to be withdrawed)
      await (
        await veV1.connect(userA).createLock(parseEther('1'), 2 * YEAR)
      ).wait()
      await (
        await veV1
          .connect(deployer)
          .createLockFor(parseEther('5'), 2 * YEAR, userB.address)
      ).wait()
      expect((await veV1.ownerToId(userA.address)).toNumber()).to.eq(1)
      expect((await veV1.ownerToId(userB.address)).toNumber()).to.eq(2)
      expect((await veV1.ownerToId(userC.address)).toNumber()).to.eq(0)
      expect((await veV1.ownerToId(userD.address)).toNumber()).to.eq(0)
      expect(formatEther(await veV1.supply())).to.eq('6.0')
      expect(formatEther(await oal.balanceOf(userA.address))).to.eq('99.0')
      expect(formatEther(await oal.balanceOf(userB.address))).to.eq('100.0')
      //// new lock
      await (
        await veV1.connect(userA).createLock(parseEther('10'), 2 * YEAR)
      ).wait()
      await (
        await veV1
          .connect(deployer)
          .createLockFor(parseEther('50'), 2 * YEAR, userB.address)
      ).wait()
      expect((await veV1.ownerToId(userA.address)).toNumber()).to.eq(3)
      expect((await veV1.ownerToId(userB.address)).toNumber()).to.eq(4)
      expect((await veV1.ownerToId(userC.address)).toNumber()).to.eq(0)
      expect((await veV1.ownerToId(userD.address)).toNumber()).to.eq(0)
      expect(formatEther(await veV1.supply())).to.eq('66.0')
      expect(formatEther(await oal.balanceOf(userA.address))).to.eq('89.0')
      expect(formatEther(await oal.balanceOf(userB.address))).to.eq('100.0')

      // in V2Rev2
      const veV2Rev2 = await upgradeToV2Rev2(
        deployer,
        await upgradeToV2(deployer, veV1)
      )
      //// Check current locks
      expect(await veV2Rev2.getOwnerFromLockerId(1)).to.eq(userA.address)
      expect(await veV2Rev2.getOwnerFromLockerId(2)).to.eq(userB.address)
      expect(await veV2Rev2.getOwnerFromLockerId(3)).to.eq(userA.address)
      expect(await veV2Rev2.getOwnerFromLockerId(4)).to.eq(userB.address)
      expect(await veV2Rev2.getOwnerFromLockerId(5)).to.eq(ZERO_ADDRESS)
      //// exec .withdrawEmergency for userA
      await (
        await veV2Rev2.connect(deployer).withdrawEmergency(1, 3, userA.address)
      ).wait()
      expect(await veV2Rev2.getOwnerFromLockerId(1)).to.eq(ZERO_ADDRESS) // withdrawed
      expect(await veV2Rev2.getOwnerFromLockerId(2)).to.eq(userB.address)
      expect(await veV2Rev2.getOwnerFromLockerId(3)).to.eq(userA.address)
      expect(await veV2Rev2.getOwnerFromLockerId(4)).to.eq(userB.address)
      expect(await veV2Rev2.getOwnerFromLockerId(5)).to.eq(ZERO_ADDRESS)
      expect((await veV2Rev2.ownerToId(userA.address)).toNumber()).to.eq(3) // not remove ownerToId for deleting multi lockers
      expect((await veV2Rev2.ownerToId(userB.address)).toNumber()).to.eq(4)
      expect((await veV2Rev2.ownerToId(userC.address)).toNumber()).to.eq(0)
      expect((await veV2Rev2.ownerToId(userD.address)).toNumber()).to.eq(0)
      expect(formatEther(await veV2Rev2.supply())).to.eq('65.0')
      expect(formatEther(await oal.balanceOf(userA.address))).to.eq('90.0')
      expect(formatEther(await oal.balanceOf(userB.address))).to.eq('100.0')

      //// exec .withdrawEmergency for userB
      await (
        await veV2Rev2.connect(deployer).withdrawEmergency(2, 4, userB.address)
      ).wait()
      expect(await veV2Rev2.getOwnerFromLockerId(1)).to.eq(ZERO_ADDRESS)
      expect(await veV2Rev2.getOwnerFromLockerId(2)).to.eq(ZERO_ADDRESS) // withdrawed
      expect(await veV2Rev2.getOwnerFromLockerId(3)).to.eq(userA.address)
      expect(await veV2Rev2.getOwnerFromLockerId(4)).to.eq(userB.address)
      expect(await veV2Rev2.getOwnerFromLockerId(5)).to.eq(ZERO_ADDRESS)
      expect((await veV2Rev2.ownerToId(userA.address)).toNumber()).to.eq(3)
      expect((await veV2Rev2.ownerToId(userB.address)).toNumber()).to.eq(4) // not remove ownerToId for deleting multi lockers
      expect((await veV2Rev2.ownerToId(userC.address)).toNumber()).to.eq(0)
      expect((await veV2Rev2.ownerToId(userD.address)).toNumber()).to.eq(0)
      expect(formatEther(await veV2Rev2.supply())).to.eq('60.0')
      expect(formatEther(await oal.balanceOf(userA.address))).to.eq('90.0')
      expect(formatEther(await oal.balanceOf(userB.address))).to.eq('105.0')
    })

    describe('cases: if exists multi locks in a user', () => {
      const _setup = async () => {
        const AMOUNT = parseEther('100')
        const { deployer, users, oal } = await setup()
        const NUM_OF_USERS = 4
        const _users = users.splice(0, NUM_OF_USERS)
        const [userA, userB, userC, notLockedUser] = _users

        const veV1 = await deployVeV1(deployer, oal.address)
        await multiTransferOal({
          users: _users,
          length: NUM_OF_USERS,
          amount: AMOUNT,
          oal,
          holder: deployer,
        })
        for await (const _user of [deployer, ..._users]) {
          const tx = await oal.connect(_user).approve(veV1.address, AMOUNT)
          await tx.wait()
        }
        let tx: ContractTransaction
        tx = await veV1.connect(userA).createLock(parseEther('10'), 2 * YEAR)
        await tx.wait()
        tx = await veV1.connect(userB).createLock(parseEther('20'), 2 * YEAR)
        await tx.wait()
        tx = await veV1.connect(userC).createLock(parseEther('30'), 1 * YEAR)
        await tx.wait()
        tx = await veV1.connect(userA).createLock(parseEther('40'), 1 * YEAR)
        await tx.wait()
        tx = await veV1.connect(userB).createLock(parseEther('50'), 0.5 * YEAR)
        await tx.wait()

        const veV2 = await upgradeToV2(deployer, veV1)
        const veV2Rev2 = await upgradeToV2Rev2(deployer, veV2)

        return {
          votingEscrow: veV2Rev2.connect(deployer),
          deployer,
          users,
           oal,
          userA,
          userB,
          userC,
          notLockedUser,
        }
      }
      it('check validations', async () => {
        const {
          votingEscrow: ve,
          oal,
          userA,
          userB,
          userC,
          notLockedUser,
        } = await _setup()
        const ZERO_ADDRESS = ethers.constants.AddressZero

        const checkPointHistory = async (ve: VotingEscrowV2Rev2) => {
          console.log('.checkPointHistory ---------------------')
          const epoch = (await ve.epoch()).toNumber()
          console.log(`> epoch: ${epoch}`)
          const ph = await ve.pointHistory(epoch)
          console.log({
            bias: ethers.utils.formatEther(ph.bias),
            slope: ethers.utils.formatEther(ph.slope),
            ts: ph.ts.toNumber(),
            tsDate: new Date(ph.ts.toNumber() * 1000).toISOString(),
            blk: ph.blk.toString(),
          })
          console.log('----------------------------------------')
        }

        // Prerequisites
        expect(await ve.getOwnerFromLockerId(1)).to.eq(userA.address)
        expect(await ve.getOwnerFromLockerId(2)).to.eq(userB.address)
        expect(await ve.getOwnerFromLockerId(3)).to.eq(userC.address)
        expect(await ve.getOwnerFromLockerId(4)).to.eq(userA.address)
        expect(await ve.getOwnerFromLockerId(5)).to.eq(userB.address)
        expect(await ve.getOwnerFromLockerId(6)).to.eq(ZERO_ADDRESS)
        expect((await ve.ownerToId(userA.address)).toNumber()).to.eq(4)
        expect((await ve.ownerToId(userB.address)).toNumber()).to.eq(5)
        expect((await ve.ownerToId(userC.address)).toNumber()).to.eq(3)
        expect((await ve.ownerToId(notLockedUser.address)).toNumber()).to.eq(0)
        expect(formatEther(await ve.supply())).to.eq('150.0')
        expect(formatEther(await oal.balanceOf(userA.address))).to.eq('50.0')
        expect(formatEther(await oal.balanceOf(userB.address))).to.eq('30.0')
        expect(formatEther(await oal.balanceOf(userC.address))).to.eq('70.0')
        await checkPointHistory(ve) // DEBUG

        const params = [
          // revert if not collect _for
          {
            targetLockerId: 1,
            currentLockerId: 4,
            for: userB.address,
            msg: '_owner not equal to _for',
          },
          {
            targetLockerId: 2,
            currentLockerId: 5,
            for: userA.address,
            msg: '_owner not equal to _for',
          },
          // revert if not collect _targetLockerId
          {
            targetLockerId: 2,
            currentLockerId: 4,
            for: userA.address,
            msg: '_owner not equal to _for',
          },
          {
            targetLockerId: 1,
            currentLockerId: 5,
            for: userB.address,
            msg: '_owner not equal to _for',
          },
          // revert if not collect _currentLockerId
          {
            targetLockerId: 1,
            currentLockerId: 5,
            for: userA.address,
            msg: 'Need same owner of _targetLId,_currentLId',
          },
          {
            targetLockerId: 2,
            currentLockerId: 4,
            for: userB.address,
            msg: 'Need same owner of _targetLId,_currentLId',
          },
          // revert if ids is duplicated
          {
            targetLockerId: 1,
            currentLockerId: 1,
            for: userA.address,
            msg: '_currentLockerId is older than _targetLockerId',
          },
          {
            targetLockerId: 2,
            currentLockerId: 2,
            for: userB.address,
            msg: '_currentLockerId is older than _targetLockerId',
          },
          {
            targetLockerId: 4,
            currentLockerId: 4,
            for: userA.address,
            msg: '_currentLockerId is older than _targetLockerId',
          },
          {
            targetLockerId: 5,
            currentLockerId: 5,
            for: userB.address,
            msg: '_currentLockerId is older than _targetLockerId',
          },
          // revert if ids is reversed (need that _targetLId is older than _currentLId)
          {
            targetLockerId: 4,
            currentLockerId: 1,
            for: userA.address,
            msg: '_currentLockerId is older than _targetLockerId',
          },
          {
            targetLockerId: 5,
            currentLockerId: 2,
            for: userB.address,
            msg: '_currentLockerId is older than _targetLockerId',
          },
        ]
        for await (const p of params) {
          await expect(
            ve.withdrawEmergency(p.targetLockerId, p.currentLockerId, p.for)
          ).to.revertedWith(p.msg)
        }

        // execute .withdrawEmergency -> success
        await expect(ve.withdrawEmergency(1, 4, userA.address)).to.emit(
          ve,
          'WithdrawEmergency'
        )
        await expect(ve.withdrawEmergency(2, 5, userB.address)).to.emit(
          ve,
          'WithdrawEmergency'
        )
        expect(formatEther(await ve.supply())).to.eq('120.0')
        expect(formatEther(await oal.balanceOf(userA.address))).to.eq('60.0')
        expect(formatEther(await oal.balanceOf(userB.address))).to.eq('50.0')
        expect(formatEther(await oal.balanceOf(userC.address))).to.eq('70.0')
        await checkPointHistory(ve) // DEBUG

        // revert if reexecute .withdrawEmergency
        await expect(ve.withdrawEmergency(1, 4, userA.address)).to.revertedWith(
          'No address associeted with owner'
        )
        await expect(ve.withdrawEmergency(2, 5, userB.address)).to.revertedWith(
          'No address associeted with owner'
        )
      })
      it('transfer to msg.sender if use .withdrawEmergencyToMsgSender', async () => {
        const { votingEscrow, oal, userA, userB, notLockedUser } =
          await _setup()

        // Preparations
        const agency = notLockedUser
        await (await votingEscrow.addAgency(agency.address)).wait()
        const ve = votingEscrow.connect(agency)

        // before: check
        expect(formatEther(await oal.balanceOf(userA.address))).to.eq('50.0')
        expect(formatEther(await oal.balanceOf(userB.address))).to.eq('30.0')
        expect(formatEther(await oal.balanceOf(agency.address))).to.eq('100.0')

        // Execute
        await (
          await ve.withdrawEmergencyToMsgSender(1, 4, userA.address)
        ).wait()
        expect(formatEther(await oal.balanceOf(userA.address))).to.eq('50.0') // not increased
        expect(formatEther(await oal.balanceOf(agency.address))).to.eq('110.0') // increase in msg.sender's

        await (
          await ve.withdrawEmergencyToMsgSender(2, 5, userB.address)
        ).wait()
        expect(formatEther(await oal.balanceOf(userB.address))).to.eq('30.0') // not increased
        expect(formatEther(await oal.balanceOf(agency.address))).to.eq('130.0') // increase in msg.sender's

        await expect(
          ve.withdrawEmergencyToMsgSender(1, 4, userA.address)
        ).to.revertedWith('No address associeted with owner')
        await expect(
          ve.withdrawEmergencyToMsgSender(2, 5, userB.address)
        ).to.revertedWith('No address associeted with owner')
      })
    })

    describe('revert cases: simple logics', () => {
      const _setup = async () => {
        const { deployer, users, oal } = await setup()
        const _veV1 = await deployVeV1(deployer, oal.address)
        const _veV2 = await upgradeToV2(deployer, _veV1)
        const ve = await upgradeToV2Rev2(deployer, _veV2)
        return {
          deployer,
          users,
           oal,
          ve,
        }
      }

      let ve: VotingEscrowV2Rev2
      let minter: SignerWithAddress
      let lockedUser: SignerWithAddress
      let notLockUser: SignerWithAddress
      before(async () => {
        const { ve: votingEscrow, deployer, users, oal } = await _setup()
        const NUM_OF_USERS = 2
        const _users = users.splice(0, NUM_OF_USERS)
        const [userA, userB] = _users

        await multiTransferOal({
          users: _users,
          length: NUM_OF_USERS,
          amount: parseEther('100'),
          oal,
          holder: deployer,
        })
        for await (const _user of [deployer, ..._users]) {
          const tx = await oal
            .connect(_user)
            .approve(votingEscrow.address, parseEther('100'))
          await tx.wait()
        }

        await (
          await votingEscrow.connect(userA).createLock('100', 2 * YEAR)
        ).wait()

        ve = votingEscrow
        minter = deployer
        lockedUser = userA
        notLockUser = userB
      })

      it('if not minter', async () => {
        const _lockerId = (await ve.ownerToId(lockedUser.address)).toNumber()
        await expect(
          ve
            .connect(lockedUser)
            .withdrawEmergency(_lockerId, 0, lockedUser.address)
        ).to.revertedWith('msg.sender is not agency')
        await expect(
          ve
            .connect(notLockUser)
            .withdrawEmergency(_lockerId, 0, notLockUser.address)
        ).to.revertedWith('msg.sender is not agency')
      })
      it('if _targetLockerId = 0 or _currentLockerId = 0 or _for = zero address', async () => {
        const _ve = ve.connect(minter)
        await expect(
          _ve.withdrawEmergency(0, 1, lockedUser.address)
        ).to.revertedWith('_targetLockerId is zero')
        await expect(
          _ve.withdrawEmergency(1, 0, lockedUser.address)
        ).to.revertedWith('_currentLockerId is zero')
        await expect(
          _ve.withdrawEmergency(1, 1, ethers.constants.AddressZero)
        ).to.revertedWith('_for is zero address')
      })
      it('if _targetLockerId >= _currentLockerId', async () => {
        const _id = (await ve.latestLockerId()).toNumber()
        const _ve = ve.connect(minter)
        await expect(
          _ve.withdrawEmergency(_id + 2, _id + 1, lockedUser.address)
        ).to.revertedWith('_currentLockerId is older than _targetLockerId')
        await expect(
          _ve.withdrawEmergency(_id + 2, _id + 2, lockedUser.address)
        ).to.revertedWith('_currentLockerId is older than _targetLockerId')
      })
      it('if no locker related with locker id', async () => {
        const _lockerId = (await ve.latestLockerId()).toNumber()
        await expect(
          ve
            .connect(minter)
            .withdrawEmergency(_lockerId + 1, _lockerId + 2, lockedUser.address)
        ).to.revertedWith('No address associeted with owner')
      })
    })
  })
})
