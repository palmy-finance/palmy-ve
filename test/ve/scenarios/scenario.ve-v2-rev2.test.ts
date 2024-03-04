import { expect } from 'chai'
import { BigNumber } from 'ethers'
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
} from '../../../types'
import { multiTransferOal, YEAR } from '../utils'

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

describe('scenario: check operation for VotingEscrowV2Rev2', () => {
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

  it('multi createLock in V1 -> (V2 ->) -> withdrawEmergency in V2Rev3', async () => {
    const { deployer, users,  oal } = await _setup()
    const NUM_OF_USERS = 3
    const ZERO_ADDRESS = ethers.constants.AddressZero
    const _users = users.splice(0, NUM_OF_USERS)
    const [userA, userB, userC] = _users

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

    const checkPointHistory = async (ve: VotingEscrow | VotingEscrowV2Rev2) => {
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

    // in V1
    //// create first locker by .createLock / .createLockFor
    await (
      await veV1.connect(userA).createLock(parseEther('30'), 2 * YEAR)
    ).wait()
    await (
      await veV1
        .connect(deployer)
        .createLockFor(parseEther('15'), 2 * YEAR, userB.address)
    ).wait()
    await checkPointHistory(veV1) // Debug
    expect((await veV1.ownerToId(userA.address)).toNumber()).to.eq(1)
    expect((await veV1.ownerToId(userB.address)).toNumber()).to.eq(2)
    expect((await veV1.ownerToId(userC.address)).toNumber()).to.eq(0)
    expect(formatEther(await oal.balanceOf(userA.address))).to.eq('70.0')
    expect(formatEther(await oal.balanceOf(userB.address))).to.eq('100.0')
    expect(formatEther(await veV1.supply())).to.eq('45.0')
    //// create second locker by .createLock / .createLockFor
    await (
      await veV1
        .connect(deployer)
        .createLockFor(parseEther('25'), 2 * YEAR, userB.address)
    ).wait()
    await (
      await veV1.connect(userA).createLock(parseEther('50'), 2 * YEAR)
    ).wait()
    await checkPointHistory(veV1) // Debug
    expect((await veV1.ownerToId(userA.address)).toNumber()).to.eq(4)
    expect((await veV1.ownerToId(userB.address)).toNumber()).to.eq(3)
    expect((await veV1.ownerToId(userC.address)).toNumber()).to.eq(0)
    expect(formatEther(await oal.balanceOf(userA.address))).to.eq('20.0')
    expect(formatEther(await oal.balanceOf(userB.address))).to.eq('100.0')
    expect(formatEther(await veV1.supply())).to.eq('120.0')

    // Upgrade: -> V2 -> V2Rev2
    const veV2 = (await upgrades.upgradeProxy(
      veV1,
      new VotingEscrowV2__factory(deployer),
      { call: { fn: 'initializeV2' } }
    )) as VotingEscrowV2
    await veV2.deployTransaction.wait()
    const veV2Rev2 = (await upgrades.upgradeProxy(
      veV2,
      new VotingEscrowV2Rev2__factory(deployer),
      { call: { fn: 'initializeV2Rev2' } }
    )) as VotingEscrowV2Rev2
    await veV2Rev2.deployTransaction.wait()

    // in V2Rev2
    //// Check current lock status
    expect(await veV2Rev2.getOwnerFromLockerId(1)).to.eq(userA.address)
    expect(await veV2Rev2.getOwnerFromLockerId(2)).to.eq(userB.address)
    expect(await veV2Rev2.getOwnerFromLockerId(3)).to.eq(userB.address)
    expect(await veV2Rev2.getOwnerFromLockerId(4)).to.eq(userA.address)
    //// check not to create multi lockers
    await expect(
      veV2Rev2.connect(userA).createLock('1', 2 * YEAR)
    ).to.revertedWith('_to already has locker id')
    await expect(
      veV2Rev2.connect(deployer).createLockFor('1', 2 * YEAR, userB.address)
    ).to.revertedWith('_to already has locker id')
    //// exec .withdrawEmergency
    ////// resolve userA
    await (
      await veV2Rev2.connect(deployer).withdrawEmergency(1, 4, userA.address)
    ).wait()
    await checkPointHistory(veV2Rev2) // Debug
    expect(await veV2Rev2.getOwnerFromLockerId(1)).to.eq(ZERO_ADDRESS)
    expect(await veV2Rev2.getOwnerFromLockerId(2)).to.eq(userB.address)
    expect(await veV2Rev2.getOwnerFromLockerId(3)).to.eq(userB.address)
    expect(await veV2Rev2.getOwnerFromLockerId(4)).to.eq(userA.address)
    expect(formatEther(await oal.balanceOf(userA.address))).to.eq('50.0')
    expect(formatEther(await oal.balanceOf(userB.address))).to.eq('100.0')
    expect(formatEther(await veV1.supply())).to.eq('90.0')
    ////// resolve userB
    await (
      await veV2Rev2.connect(deployer).withdrawEmergency(2, 3, userB.address)
    ).wait()
    await checkPointHistory(veV2Rev2) // Debug
    expect(await veV2Rev2.getOwnerFromLockerId(1)).to.eq(ZERO_ADDRESS)
    expect(await veV2Rev2.getOwnerFromLockerId(2)).to.eq(ZERO_ADDRESS)
    expect(await veV2Rev2.getOwnerFromLockerId(3)).to.eq(userB.address)
    expect(await veV2Rev2.getOwnerFromLockerId(4)).to.eq(userA.address)
    expect(formatEther(await oal.balanceOf(userA.address))).to.eq('50.0')
    expect(formatEther(await oal.balanceOf(userB.address))).to.eq('115.0')
    expect(formatEther(await veV1.supply())).to.eq('75.0')
    //// not update ownerToId
    expect((await veV1.ownerToId(userA.address)).toNumber()).to.eq(4)
    expect((await veV1.ownerToId(userB.address)).toNumber()).to.eq(3)
    expect((await veV1.ownerToId(userC.address)).toNumber()).to.eq(0)

    //// extra
    // await (await veV2Rev2.connect(deployer).withdrawEmergency(3)).wait()
    // await (await veV2Rev2.connect(deployer).withdrawEmergency(4)).wait()
    // await checkPointHistory(veV2Rev2) // Debug
    // expect(formatEther(await oal.balanceOf(userA.address))).to.eq('100.0')
    // expect(formatEther(await oal.balanceOf(userB.address))).to.eq('140.0')
    // expect(formatEther(await veV1.supply())).to.eq('0.0')
  })
})
