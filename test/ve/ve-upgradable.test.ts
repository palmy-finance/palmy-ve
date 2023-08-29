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
import { multiTransferOal, YEAR } from './utils'

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

  return {
    deployer,
    users: rest,
     oal,
  }
}

describe('VotingEscrow -> VotingEscrowV2', () => {
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

  it('createLock in V1 -> check lockerId in V2', async () => {
    const { deployer, users, oal } = await _setup()
    const NUM_OF_USERS = 4
    const _users = users.splice(0, NUM_OF_USERS)
    const [userA, userB, userC, userD] = _users

    const veV1 = (await upgrades.deployProxy(
      new VotingEscrow__factory(deployer),
      [oal.address]
    )) as VotingEscrow
    await veV1.deployTransaction.wait()

    for await (const _user of [deployer, ..._users]) {
      const tx = await oal
        .connect(_user)
        .approve(veV1.address, parseEther('100'))
      await tx.wait()
    }

    await (await veV1.connect(userA).createLock('1', 2 * YEAR)).wait()
    await (
      await veV1.connect(deployer).createLockFor('1', 2 * YEAR, userB.address)
    ).wait()
    expect((await veV1.ownerToId(userA.address)).toNumber()).to.eq(1)
    expect((await veV1.ownerToId(userB.address)).toNumber()).to.eq(2)
    expect((await veV1.ownerToId(userC.address)).toNumber()).to.eq(0)
    expect((await veV1.ownerToId(userD.address)).toNumber()).to.eq(0)

    const veV2 = (await upgrades.upgradeProxy(
      veV1,
      new VotingEscrowV2__factory(deployer),
      { call: { fn: 'initializeV2' } }
    )) as VotingEscrowV2
    await veV2.deployTransaction.wait()

    expect((await veV2.latestLockerId()).toNumber()).to.eq(2)
    await expect(veV2.connect(userA).createLock('1', 2 * YEAR)).to.revertedWith(
      '_to already has locker id'
    )
    await expect(veV2.connect(userB).createLock('1', 2 * YEAR)).to.revertedWith(
      '_to already has locker id'
    )
    await (await veV2.connect(userC).createLock('1', 2 * YEAR)).wait()
    await (
      await veV2.connect(deployer).createLockFor('1', 2 * YEAR, userD.address)
    ).wait()
    expect((await veV2.ownerToId(userA.address)).toNumber()).to.eq(1)
    expect((await veV2.ownerToId(userB.address)).toNumber()).to.eq(2)
    expect((await veV2.ownerToId(userC.address)).toNumber()).to.eq(3)
    expect((await veV2.ownerToId(userD.address)).toNumber()).to.eq(4)
    expect((await veV2.latestLockerId()).toNumber()).to.eq(4)
    expect(await veV2.getOwnerFromLockerId(1)).to.eq(userA.address)
    expect(await veV2.getOwnerFromLockerId(2)).to.eq(userB.address)
    expect(await veV2.getOwnerFromLockerId(3)).to.eq(userC.address)
    expect(await veV2.getOwnerFromLockerId(4)).to.eq(userD.address)
    expect(await veV2.getOwnerFromLockerId(5)).to.eq(
      ethers.constants.AddressZero
    )
    expect((await veV2.getAllLockerIdAndOwner()).length).to.eq(4)
  })
})
