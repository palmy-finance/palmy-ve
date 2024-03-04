import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { parseEther } from 'ethers/lib/utils'
import { ethers, network, upgrades } from 'hardhat'
import {
  Token,
  Token__factory,
  VotingEscrow,
  VotingEscrow__factory,
  FeeDistributor__factory,
  FeeDistributor,
} from '../../types'
const { expect } = require('chai')

const HOUR = 60 * 60 // in minute
const DAY = HOUR * 24
const WEEK = DAY * 7
const YEAR = DAY * 365
const ONE_TERM = 2 * WEEK

describe('feeDist', () => {
  let user1: SignerWithAddress
  let user2: SignerWithAddress
  let user3: SignerWithAddress
  let distributor: SignerWithAddress
  let oal: Token
  let ve: VotingEscrow

  before(async () => {
    ;[user1, user2, user3, distributor] = await ethers.getSigners()
    oal = await new Token__factory(distributor).deploy(
      'OAL',
      'OAL',
      parseEther('1000'),
      distributor.address
    )
    await oal.deployTransaction.wait()
    ve = (await upgrades.deployProxy(new VotingEscrow__factory(user1), [
      oal.address,
    ])) as VotingEscrow
    await ve.deployTransaction.wait()

    const oalTokenInstance = oal.connect(distributor)
    await oalTokenInstance.transfer(user1.address, parseEther('200'))
    await oalTokenInstance.transfer(user2.address, parseEther('100'))
    await oalTokenInstance.transfer(user3.address, parseEther('100'))
  })

  it('User1 creates lock with 100 OAL, User2 creates lock with 50 OAL, and User3 creates lock with 50 OAL', async () => {
    await oal.connect(user1).approve(ve.address, parseEther('100'))
    await ve.connect(user1).createLock(parseEther('100'), 2 * YEAR)
    expect(await ve.balanceOfLockerId(1)).to.above(parseEther('90'))
    expect(await oal.balanceOf(ve.address)).to.be.equal(parseEther('100'))

    await oal.connect(user2).approve(ve.address, parseEther('50'))
    await ve.connect(user2).createLock(parseEther('50'), 2 * YEAR)
    expect(await ve.connect(user2).balanceOfLockerId(2)).to.above(
      parseEther('40')
    )
    expect(await oal.balanceOf(ve.address)).to.be.equal(parseEther('150'))

    await oal.connect(user3).approve(ve.address, parseEther('50'))
    await ve.connect(user3).createLock(parseEther('50'), 2 * YEAR)
    expect(await ve.connect(user3).balanceOfLockerId(3)).to.above(
      parseEther('40')
    )
    expect(await oal.balanceOf(ve.address)).to.be.equal(parseEther('200'))
  })

  it('Distribute OAL: The total balance of VE contract should be increase from 200 OAL to 300 OAL', async () => {
    await network.provider.send('evm_increaseTime', [ONE_TERM])
    await network.provider.send('evm_mine')
    const feeDistributor = (await upgrades.deployProxy(
      new FeeDistributor__factory(distributor),
      [ve.address]
    )) as FeeDistributor
    await feeDistributor.deployTransaction.wait()
    // The fee 20 OAL is minted 10 times everyday
    for (let i = 0; i < 10; i++) {
      await oal
        .connect(distributor)
        .transfer(feeDistributor.address, parseEther('20'))
      await network.provider.send('evm_increaseTime', [DAY])
    }
    // Distribute the transferred fees between the current term and the following term
    await feeDistributor.checkpointToken() // Claim the fees after one term will be passed
    await network.provider.send('evm_increaseTime', [ONE_TERM])
    await feeDistributor.connect(user1).claim()
    await feeDistributor.connect(user2).claim()
    await feeDistributor.connect(user3).claim()

    expect(await oal.balanceOf(ve.address)).to.be.above(parseEther('299'))
  })
})
