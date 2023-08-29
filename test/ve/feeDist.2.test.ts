import { ethers, upgrades } from 'hardhat'
import { parseEther } from 'ethers/lib/utils'
import {
  Token__factory,
  VotingEscrow__factory,
  VotingEscrow,
  FeeDistributor,
  FeeDistributor__factory,
} from '../../types'
import { expect } from 'chai'

const setup = async () => {
  const [deployer, ...rest] = await ethers.getSigners()
  const oal = await new Token__factory(deployer).deploy(
    'OAL',
    'OAL',
    parseEther('9999999'),
    deployer.address
  )
  await oal.deployTransaction.wait()
  const votingEscrow = (await upgrades.deployProxy(
    new VotingEscrow__factory(deployer),
    [oal.address]
  )) as VotingEscrow
  await votingEscrow.deployTransaction.wait()
  const feeDistributor = (await upgrades.deployProxy(
    new FeeDistributor__factory(deployer),
    [votingEscrow.address]
  )) as FeeDistributor
  await feeDistributor.deployTransaction.wait()

  return {
    deployer,
    users: rest,
    oal,
    votingEscrow,
    feeDistributor,
  }
}

describe('FeeDistributor.sol Part2', () => {
  describe('.initialize', () => {
    it('revert if _votingEscrow is zero address', async () => {
      const [deployer] = await ethers.getSigners()

      // Execute
      await expect(
        upgrades.deployProxy(new FeeDistributor__factory(deployer), [
          ethers.constants.AddressZero,
        ])
      ).to.be.revertedWith('Zero address cannot be set')
    })
  })

  describe('Functions related to term index / timestamp', () => {
    const WEEK = 86400 * 7

    it('.currentTermIndex, .currentTermTimestamp', async () => {
      const { feeDistributor } = await setup()
      const currentTermIndex = await feeDistributor.currentTermIndex()
      expect(currentTermIndex.toNumber()).to.equal(0)
      const currentTermTimestamp = (
        await feeDistributor.currentTermTimestamp()
      ).toNumber()
      const _currentTimestamp = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp
      expect(currentTermTimestamp).to.equal(
        Math.floor(_currentTimestamp / WEEK) * WEEK
      )
    })

    it('.currentTermIndex, .currentTermTimestamp after some time', async () => {
      const { feeDistributor } = await setup()
      // Increase time
      const termTimestampAtDeployed = (
        await feeDistributor.termTimestampAtDeployed()
      ).toNumber()
      // after 1 month
      ethers.provider.send('evm_increaseTime', [WEEK * 4])
      ethers.provider.send('evm_mine', [])
      const _termIndex = (await feeDistributor.currentTermIndex()).toNumber()
      const _termTimestamp = (
        await feeDistributor.currentTermTimestamp()
      ).toNumber()
      expect(_termIndex).to.eq(4)
      expect(_termTimestamp).to.eq(termTimestampAtDeployed + WEEK * 4)
      // after 1 year
      ethers.provider.send('evm_increaseTime', [WEEK * (52 - 4)])
      ethers.provider.send('evm_mine', [])
      const __termIndex = (await feeDistributor.currentTermIndex()).toNumber()
      const __termTimestamp = (
        await feeDistributor.currentTermTimestamp()
      ).toNumber()
      expect(__termIndex).to.eq(52)
      expect(__termTimestamp).to.eq(termTimestampAtDeployed + WEEK * 52)
    })

    it('.termTimestampByIndex, .termIndexAt', async () => {
      const { feeDistributor } = await setup()
      const currentTermTimestamp = (
        await feeDistributor.currentTermTimestamp()
      ).toNumber()
      const [atDeployed, atZero, atOne, atTen, atHundred] = await Promise.all([
        feeDistributor.termTimestampAtDeployed(),
        feeDistributor.termTimestampByIndex(0),
        feeDistributor.termTimestampByIndex(1),
        feeDistributor.termTimestampByIndex(10),
        feeDistributor.termTimestampByIndex(100),
      ])
      const _term1Timestamp = currentTermTimestamp + WEEK
      const _term10Timestamp = currentTermTimestamp + WEEK * 10
      const _term100Timestamp = currentTermTimestamp + WEEK * 100

      // from index to timestamp
      expect(atDeployed.toNumber()).to.eq(currentTermTimestamp)
      expect(atZero.toNumber()).to.eq(currentTermTimestamp)
      expect(atOne.toNumber()).to.eq(_term1Timestamp)
      expect(atTen.toNumber()).to.eq(_term10Timestamp)
      expect(atHundred.toNumber()).to.eq(_term100Timestamp)
      // from timestamp to index
      expect(
        (await feeDistributor.termIndexAt(_term1Timestamp - 1)).toNumber()
      ).to.eq(0)
      expect(
        (await feeDistributor.termIndexAt(_term1Timestamp + 1)).toNumber()
      ).to.eq(1)
      expect(
        (
          await feeDistributor.termIndexAt(_term10Timestamp + WEEK - 1)
        ).toNumber()
      ).to.eq(10)
      expect(
        (await feeDistributor.termIndexAt(_term10Timestamp + WEEK)).toNumber()
      ).to.eq(11)
      expect(
        (
          await feeDistributor.termIndexAt(_term10Timestamp + WEEK + 1)
        ).toNumber()
      ).to.eq(11)
      expect(
        (
          await feeDistributor.termIndexAt(_term100Timestamp + WEEK * 50 - 1)
        ).toNumber()
      ).to.eq(149)
      expect(
        (
          await feeDistributor.termIndexAt(_term100Timestamp + WEEK * 50)
        ).toNumber()
      ).to.eq(150)
      expect(
        (
          await feeDistributor.termIndexAt(_term100Timestamp + WEEK * 50 + 1)
        ).toNumber()
      ).to.eq(150)
    })
  })

  describe('.veForAt', () => {
    it('revert if no locker', async () => {
      const { feeDistributor, votingEscrow, deployer } = await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      await expect(
        feeDistributor.connect(deployer).veForAt(0)
      ).to.be.revertedWith('No lock associated with address')
    })
  })

  describe('.claim', () => {
    it('revert if no locker', async () => {
      const { feeDistributor, votingEscrow, deployer } = await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      await expect(feeDistributor.connect(deployer).claim()).to.be.revertedWith(
        'No lock associated with address'
      )
    })
  })

  describe('.claim', () => {
    it('revert if no locker', async () => {
      const { feeDistributor, votingEscrow, deployer } = await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      await expect(
        feeDistributor.connect(deployer).claimable()
      ).to.be.revertedWith('No lock associated with address')
    })
  })
})
