import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { parseEther } from 'ethers/lib/utils'
import { ethers, upgrades } from 'hardhat'
import {
  Token__factory,
  VotingEscrow,
  VotingEscrowV2,
  VotingEscrowV2Rev2,
  VotingEscrowV2Rev2__factory,
  VotingEscrowV2Rev3,
  VotingEscrowV2Rev3__factory,
  VotingEscrowV2__factory,
  VotingEscrow__factory,
} from '../../types'
import { getCurrentTerm, multiTransferOal, TERM, YEAR } from './utils'

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
const upgradeToV2Rev3 = async (
  deployer: SignerWithAddress,
  ve: VotingEscrowV2Rev2
): Promise<VotingEscrowV2Rev3> => {
  const _veV2Rev3 = (await upgrades.upgradeProxy(
    ve.address,
    new VotingEscrowV2Rev3__factory(deployer),
    { call: { fn: 'initializeV2Rev3' } }
  )) as VotingEscrowV2Rev3
  await _veV2Rev3.deployTransaction.wait()
  return _veV2Rev3
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

describe('VotingEscrowV2Rev3.sol', () => {
  it('initialize by .initializeV2Rev3', async () => {
    const { deployer, oal } = await setup()
    const veV1 = await deployVeV1(deployer, oal.address)
    const veV2 = await upgradeToV2(deployer, veV1)
    const veV2Rev2 = await upgradeToV2Rev2(deployer, veV2)
    const veV2Rev3 = await upgradeToV2Rev3(deployer, veV2Rev2)

    const version = await veV2Rev3.version()
    expect(version).to.eq('2.0.2')
  })
  describe('.createLock, .createLockFor', () => {
    const _setup = async () => {
      const amount = parseEther('100')
      const NUM_OF_USERS = 3
      const { deployer, users,  oal } = await setup()
      const _users = users.splice(0, NUM_OF_USERS)
      await multiTransferOal({
        users: _users,
        length: NUM_OF_USERS,
        amount: amount,
        oal,
        holder: deployer,
      })
      const veV1 = await deployVeV1(deployer, oal.address)
      const veV2 = await upgradeToV2(deployer, veV1)
      const veV2Rev2 = await upgradeToV2Rev2(deployer, veV2)
      const veV2Rev3 = await upgradeToV2Rev3(deployer, veV2Rev2)

      const tx = await oal.connect(deployer).approve(veV2Rev3.address, amount)
      await tx.wait()
      for await (const _user of _users) {
        const tx = await oal.connect(_user).approve(veV2Rev3.address, amount)
        await tx.wait()
      }
      // Proceed next term
      const currentTerm = await getCurrentTerm()
      ethers.provider.send('evm_mine', [currentTerm + TERM])

      return {
        votingEscrow: veV2Rev3,
        deployer,
        users: _users,
      }
    }
    it('fail: already exist lock', async () => {
      const { votingEscrow: ve, deployer, users } = await _setup()
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
  it('check removed: .withdrawEmergency in V2Rev2', async () => {
    const { deployer, oal } = await setup()
    const veV1 = await deployVeV1(deployer, oal.address)
    const veV2 = await upgradeToV2(deployer, veV1)
    const veV2Rev2 = await upgradeToV2Rev2(deployer, veV2)

    const ve = (await upgrades.upgradeProxy(
      veV2Rev2.address,
      new VotingEscrowV2Rev3__factory(deployer),
      { call: { fn: 'initializeV2Rev3' } }
    )) as VotingEscrowV2Rev3
    await ve.deployTransaction.wait()

    const contract = new ethers.Contract(
      ve.address,
      VotingEscrowV2Rev2__factory.abi,
      deployer
    ) // use Rev2's abi to check .withdrawEmergency

    expect(await contract.version()).to.eq('2.0.2') // possible to call .version
    await expect(
      contract.withdrawEmergency(1, 1, deployer.address)
    ).to.revertedWith(
      "function selector was not recognized and there's no fallback function"
    ) // not find .withdrawEmergency signature
  })
})
