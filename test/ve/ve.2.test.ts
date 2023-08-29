import { expect } from 'chai'
import { BigNumber, ContractTransaction } from 'ethers'
import { formatEther, parseEther } from 'ethers/lib/utils'
import { ethers, upgrades } from 'hardhat'
import {
  Token__factory,
  VotingEscrow,
  VotingEscrow__factory,
} from '../../types'
import {
  currentTimestamp,
  DAY,
  getCurrentTerm,
  HOUR,
  MONTH,
  multiTransferOal,
  TERM,
  YEAR,
} from './utils'

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
  const votingEscrow = (await upgrades.deployProxy(
    new VotingEscrow__factory(deployer),
    [oal.address]
  )) as VotingEscrow
  await votingEscrow.deployTransaction.wait()

  return {
    deployer,
    users: rest,
    oal,
    votingEscrow,
  }
}

describe('VotingEscrow.sol Part2', () => {
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

  describe('.initialize', () => {
    it('success', async () => {
      const { deployer, oal, votingEscrow: ve } = await setup()
      const [name, symbol, decimals, version, token, _term, voter, isAgency] =
        await Promise.all([
          ve.name(),
          ve.symbol(),
          ve.decimals(),
          ve.version(),
          ve.token(),
          ve._term(),
          ve.voter(),
          ve.agencies(deployer.address),
        ])
      expect(name).to.eq('Vote-escrowed OAL')
      expect(symbol).to.eq('veOAL')
      expect(decimals).to.eq(18)
      expect(version).to.eq('1.0.0')
      expect(token.toLowerCase()).to.eq(oal.address.toLowerCase())
      expect(_term.toNumber()).to.eq(TERM)
      expect(voter.toLowerCase()).to.eq(deployer.address.toLowerCase())
      expect(isAgency).to.eq(true)
    })
    it('revert if tokenAddr is zero address', async () => {
      const [deployer] = await ethers.getSigners()
      await expect(
        upgrades.deployProxy(new VotingEscrow__factory(deployer), [
          ethers.constants.AddressZero,
        ])
      ).to.be.revertedWith('Zero address cannot be set')
    })
  })

  it('.supply', async () => {
    const { users, oal, votingEscrow } = await _setup({
      amount: parseEther('500'),
      count: 3,
    })
    let tx: ContractTransaction

    const beforeSupply = await votingEscrow.connect(ethers.provider).supply()
    expect(formatEther(beforeSupply)).to.eq('0.0')

    const params = [
      { user: users[0], amount: parseEther('5') },
      { user: users[1], amount: parseEther('17') },
      { user: users[2], amount: parseEther('128') },
    ]
    for await (const param of params) {
      tx = await oal
        .connect(param.user)
        .approve(votingEscrow.address, param.amount)
      await tx.wait()
      tx = await votingEscrow
        .connect(param.user)
        .createLock(param.amount, 2 * YEAR)
      await tx.wait()
    }

    const afterSupply = await votingEscrow.connect(ethers.provider).supply()
    expect(formatEther(afterSupply)).to.eq('150.0')
  })

  describe('.totalSupplyAtT', () => {
    const __setup = async () => {
      const amount = parseEther('1')
      const {
        users: [user],
        oal,
        votingEscrow,
      } = await _setup({
        amount: amount,
        count: 1,
      })
      const tx = await oal.connect(user).approve(votingEscrow.address, amount)
      await tx.wait()
      // Proceed next term
      const currentTerm = await getCurrentTerm()
      ethers.provider.send('evm_mine', [currentTerm + TERM])

      return {
        currentTerm,
        amount,
        votingEscrow: votingEscrow.connect(user),
      }
    }
    it('revert if Point.ts of current epoch > inputted timestamp', async () => {
      const { currentTerm, amount, votingEscrow } = await __setup()

      await (await votingEscrow.createLock(amount, 2 * YEAR)).wait()
      ethers.provider.send('evm_mine', [currentTerm + TERM + 2 * YEAR])
      await (await votingEscrow.checkpoint()).wait()
      const epoch = (await votingEscrow.epoch()).toNumber()
      const lastPH = await votingEscrow.pointHistory(epoch)
      for await (const num of [2, 1, 0]) {
        const totalSupply = await votingEscrow.totalSupplyAtT(
          lastPH.ts.toNumber() + num
        )
        expect(formatEther(totalSupply)).to.eq('0.0')
      }
      await expect(
        votingEscrow.totalSupplyAtT(lastPH.ts.toNumber() - 1)
      ).to.be.revertedWith('Requires that t >= point.ts')
    })
  })

  describe('.createLock', () => {
    const __setup = async () => {
      const amount = parseEther('1')
      const {
        users: [user],
        oal,
        votingEscrow,
      } = await _setup({
        amount: amount,
        count: 1,
      })
      const tx = await oal.connect(user).approve(votingEscrow.address, amount)
      await tx.wait()
      // Proceed next term
      const currentTerm = await getCurrentTerm()
      ethers.provider.send('evm_mine', [currentTerm + TERM])

      return {
        votingEscrow: votingEscrow.connect(user),
      }
    }
    it('success', async () => {
      const { votingEscrow } = await __setup()
      await expect(votingEscrow.createLock('1', 2 * YEAR)).to.be.emit(
        votingEscrow,
        'Deposit'
      )
    })
    it('fail: over', async () => {
      const { votingEscrow } = await __setup()
      await expect(
        votingEscrow.createLock('1', 2 * YEAR + TERM)
      ).to.be.revertedWith('Voting lock can be 2 years max')
    })
    it('fail: shorten', async () => {
      const { votingEscrow } = await __setup()
      await expect(
        votingEscrow.createLock('1', TERM - 1 * HOUR)
      ).to.be.revertedWith('Can only lock until time in the future')
    })
  })

  describe('.createLock 2', () => {
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

    it('Check current logic (not fail: already exist lock)', async () => {
      const { votingEscrow: ve, deployer, users } = await __setup()
      const [userA, userB, userC] = users

      await ve.connect(userA).createLock('1', 2 * YEAR)
      await ve.connect(userB).createLock('1', 2 * YEAR)
      expect((await ve.ownerToId(userA.address)).toNumber()).to.eq(1)
      expect((await ve.ownerToId(userB.address)).toNumber()).to.eq(2)
      expect((await ve.ownerToId(userC.address)).toNumber()).to.eq(0)

      await ve.connect(userA).createLock('1', 2 * YEAR)
      expect((await ve.ownerToId(userA.address)).toNumber()).to.eq(3)
      await ve.connect(deployer).createLockFor('1', 2 * YEAR, userA.address)
      expect((await ve.ownerToId(userA.address)).toNumber()).to.eq(4)
    })
  })

  describe('.increaseAmount', () => {
    it('success & check .locked', async () => {
      const {
        users: [userA],
        oal,
        votingEscrow,
      } = await _setup({
        amount: parseEther('1357.9'),
        count: 1,
      })
      let tx: ContractTransaction
      tx = await oal
        .connect(userA)
        .approve(votingEscrow.address, ethers.constants.MaxUint256)
      await tx.wait()

      // First
      const first = parseEther('1010')
      tx = await votingEscrow
        .connect(userA)
        .createLock(first.toString(), 2 * YEAR)
      await tx.wait()
      // - get lockerId after createLock
      const lockerId = (await votingEscrow.ownerToId(userA.address)).toString()
      const locked1st = await votingEscrow.locked(lockerId)
      expect(locked1st.amount.toString()).to.eq(first.toString())

      // Second
      const second = parseEther('310')
      tx = await votingEscrow.connect(userA).increaseAmount(second.toString())
      await tx.wait()
      const locked2nd = await votingEscrow.locked(lockerId)
      expect(locked2nd.amount.toString()).to.eq(first.add(second).toString())
      expect(locked2nd.end).to.eq(locked1st.end)

      // Third
      const third = parseEther('37.9')
      tx = await votingEscrow.connect(userA).increaseAmount(third.toString())
      await tx.wait()
      const locked3rd = await votingEscrow.locked(lockerId)
      expect(locked3rd.amount.toString()).to.eq(
        first.add(second).add(third).toString()
      )
      expect(locked3rd.end).to.eq(locked1st.end)
    })
    describe('success & check .pointHistory', () => {
      const LOCK_DURATION = 2 * YEAR
      const AMOUNT = parseEther('10100')
      const INITIAL_LOCK_AMOUNT = parseEther('100')
      const _execute = async () => {
        // Prerequisites: advance time to the next term
        const _currentTerm = await getCurrentTerm()
        const advancedCurrent = _currentTerm + TERM
        ethers.provider.send('evm_mine', [advancedCurrent])

        // Prerequisites: deploy & .createLock
        const {
          users: [userA],
          oal,
          votingEscrow,
        } = await _setup({
          amount: AMOUNT,
          count: 1,
        })
        let tx: ContractTransaction
        tx = await oal
          .connect(userA)
          .approve(votingEscrow.address, ethers.constants.MaxUint256)
        await tx.wait()

        const currentTs = await currentTimestamp()
        tx = await votingEscrow
          .connect(userA)
          .createLock(INITIAL_LOCK_AMOUNT, LOCK_DURATION)
        await tx.wait()

        return {
          currentTs,
          votingEscrow,
          user: userA,
        }
      }
      it('no .increaseAmount', async () => {
        const { currentTs, votingEscrow } = await _execute()
        expect((await votingEscrow.epoch()).toNumber()).to.eq(1)

        ethers.provider.send('evm_mine', [currentTs + LOCK_DURATION])
        await (await votingEscrow.checkpoint()).wait()

        const epoch = (await votingEscrow.epoch()).toNumber()
        expect(epoch).to.eq(54)
        const pointHistories = await Promise.all([
          votingEscrow.pointHistory(0), // at deployed
          votingEscrow.pointHistory(1), // at the start
          votingEscrow.pointHistory(2),
          votingEscrow.pointHistory(26 + 1), // 1 year
          votingEscrow.pointHistory(52 + 1 - 1), // 2 year - 1
          votingEscrow.pointHistory(52 + 1), // 2 year
          votingEscrow.pointHistory(epoch),
        ])
        const [ph0, ph1, ph2, phOneYear, phBeforeTwoYear, phTwoYear, phEpoch] =
          pointHistories
        expect(Number(formatEther(ph0.bias))).to.eq(0)
        expect(Number(formatEther(ph1.bias))).to.gt(99)
        expect(Number(formatEther(ph2.bias))).to.gt(98)
        expect(Number(formatEther(phOneYear.bias))).to.lt(50)
        expect(Number(formatEther(phOneYear.bias))).to.gte(49)
        expect(Number(formatEther(phBeforeTwoYear.bias))).to.gt(0)
        expect(Number(formatEther(phTwoYear.bias))).to.eq(0)
        expect(Number(formatEther(phEpoch.bias))).to.eq(0)

        // For Debug
        // for await (const ph of pointHistories) {
        //   console.log({
        //     bias: formatEther(ph.bias),
        //     slope: formatEther(ph.slope),
        //     ts: new Date(ph.ts.toNumber() * 1000).toISOString(),
        //     blk: ph.blk.toNumber(),
        //   })
        // }
      })

      it('if user increaseAmount with 100', async () => {
        const { currentTs, votingEscrow, user } = await _execute()

        // Execute
        await (
          await votingEscrow.connect(user).increaseAmount(parseEther('100'))
        ).wait()

        ethers.provider.send('evm_mine', [currentTs + LOCK_DURATION])
        await (await votingEscrow.checkpoint()).wait()

        const epoch = (await votingEscrow.epoch()).toNumber()
        expect(epoch).to.eq(55)
        const pointHistories = await Promise.all([
          votingEscrow.pointHistory(0), // at deployed
          votingEscrow.pointHistory(1), // at the start (by createLock)
          votingEscrow.pointHistory(2), // at the start (by increaseAmount)
          votingEscrow.pointHistory(3),
          votingEscrow.pointHistory(26 + 2), // 1 year
          votingEscrow.pointHistory(52 + 2 - 1), // 2 year - 1
          votingEscrow.pointHistory(52 + 2), // 2 year
          votingEscrow.pointHistory(epoch),
        ])
        const [
          ph0,
          ph1,
          ph2,
          ph3,
          phOneYear,
          phBeforeTwoYear,
          phTwoYear,
          phEpoch,
        ] = pointHistories
        expect(Number(formatEther(ph0.bias))).to.eq(0)
        expect(Number(formatEther(ph1.bias))).to.gt(99)
        expect(Number(formatEther(ph2.bias))).to.gt(198)
        expect(Number(formatEther(ph3.bias))).to.gt(196)
        expect(Number(formatEther(phOneYear.bias))).to.lt(100)
        expect(Number(formatEther(phOneYear.bias))).to.gte(98)
        expect(Number(formatEther(phBeforeTwoYear.bias))).to.gt(0)
        expect(Number(formatEther(phTwoYear.bias))).to.eq(0)
        expect(Number(formatEther(phEpoch.bias))).to.eq(0)
      })

      it('if user increaseAmount with 4900 (= total is 5000)', async () => {
        const { currentTs, votingEscrow, user } = await _execute()

        // Execute
        await (
          await votingEscrow.connect(user).increaseAmount(parseEther('4900'))
        ).wait()

        ethers.provider.send('evm_mine', [currentTs + LOCK_DURATION])
        await (await votingEscrow.checkpoint()).wait()

        const epoch = (await votingEscrow.epoch()).toNumber()
        expect(epoch).to.eq(55)
        const pointHistories = await Promise.all([
          votingEscrow.pointHistory(0), // at deployed
          votingEscrow.pointHistory(1), // at the start (by createLock)
          votingEscrow.pointHistory(2), // at the start (by increaseAmount)
          votingEscrow.pointHistory(3),
          votingEscrow.pointHistory(26 + 2), // 1 year
          votingEscrow.pointHistory(52 + 2 - 1), // 2 year - 1
          votingEscrow.pointHistory(52 + 2), // 2 year
          votingEscrow.pointHistory(epoch),
        ])
        const [
          ph0,
          ph1,
          ph2,
          ph3,
          phOneYear,
          phBeforeTwoYear,
          phTwoYear,
          phEpoch,
        ] = pointHistories
        expect(Number(formatEther(ph0.bias))).to.eq(0)
        expect(Number(formatEther(ph1.bias))).to.gt(99)
        expect(Number(formatEther(ph2.bias))).to.gt(4995)
        expect(Number(formatEther(ph3.bias))).to.gt(4900)
        expect(Number(formatEther(phOneYear.bias))).to.lt(2500)
        expect(Number(formatEther(phOneYear.bias))).to.gte(2495)
        expect(Number(formatEther(phBeforeTwoYear.bias))).to.gt(0)
        expect(Number(formatEther(phTwoYear.bias))).to.eq(0)
        expect(Number(formatEther(phEpoch.bias))).to.eq(0)
      })
    })
  })

  describe('.increaseUnlockTime', () => {
    it('success & check .locked', async () => {
      const AMOUNT = parseEther('100')
      const {
        users: [userA],
        oal,
        votingEscrow,
      } = await _setup({
        amount: AMOUNT,
        count: 1,
      })
      const current = await currentTimestamp()
      const roundByTerm = (ts: number) => Math.floor(ts / TERM) * TERM

      let tx: ContractTransaction
      tx = await oal
        .connect(userA)
        .approve(votingEscrow.address, ethers.constants.MaxUint256)
      await tx.wait()

      // Initial
      const initialDuration = 2 * TERM
      tx = await votingEscrow.connect(userA).createLock(AMOUNT, initialDuration)
      await tx.wait()
      // - get lockerId after createLock
      const lockerId = (await votingEscrow.ownerToId(userA.address)).toString()
      const initialLocked = await votingEscrow.locked(lockerId)
      expect(initialLocked.end.toNumber()).to.eq(
        roundByTerm(current + initialDuration)
      )
      expect(initialLocked.amount).to.eq(AMOUNT)

      for await (const duration of [
        8 * TERM,
        6 * MONTH,
        1 * YEAR,
        1.5 * YEAR,
        2 * YEAR,
      ]) {
        tx = await votingEscrow.connect(userA).increaseUnlockTime(duration)
        await tx.wait()
        const locked = await votingEscrow.locked(lockerId)
        expect(locked.end.toNumber()).to.eq(roundByTerm(current + duration))
        expect(locked.amount).to.eq(AMOUNT)
      }
    })
    describe('success & check .pointHistory', () => {
      const INITIAL_LOCK_DURATION = 2 * TERM
      const AMOUNT = parseEther('10000')
      const _execute = async () => {
        // Prerequisites: advance time to the next term
        const _currentTerm = await getCurrentTerm()
        const advancedCurrent = _currentTerm + TERM
        ethers.provider.send('evm_mine', [advancedCurrent])

        // Prerequisites: deploy & .createLock
        const {
          users: [userA],
          oal,
          votingEscrow,
        } = await _setup({
          amount: AMOUNT,
          count: 1,
        })
        let tx: ContractTransaction
        tx = await oal
          .connect(userA)
          .approve(votingEscrow.address, ethers.constants.MaxUint256)
        await tx.wait()

        const currentTs = await currentTimestamp()
        tx = await votingEscrow
          .connect(userA)
          .createLock(AMOUNT, INITIAL_LOCK_DURATION)
        await tx.wait()

        return {
          currentTs,
          votingEscrow,
          user: userA,
        }
      }
      it('no .increaseUnlockTime', async () => {
        const { currentTs, votingEscrow } = await _execute()
        expect((await votingEscrow.epoch()).toNumber()).to.eq(1)

        ethers.provider.send('evm_mine', [currentTs + 2 * YEAR])
        await (await votingEscrow.checkpoint()).wait()

        const epoch = (await votingEscrow.epoch()).toNumber()
        expect(epoch).to.eq(54)
        const pointHistories = await Promise.all([
          votingEscrow.pointHistory(0), // at deployed
          votingEscrow.pointHistory(1), // at the start
          votingEscrow.pointHistory(2),
          votingEscrow.pointHistory(3),
          votingEscrow.pointHistory(26 + 1 - 1), // 1 year - 1
          votingEscrow.pointHistory(26 + 1), // 1 year
          votingEscrow.pointHistory(52 + 1 - 1), // 2 year - 1
          votingEscrow.pointHistory(52 + 1), // 2 year
          votingEscrow.pointHistory(epoch),
        ])
        const [
          ph0,
          ph1,
          ph2,
          ph3,
          phBeforeOneYear,
          phOneYear,
          phBeforeTwoYear,
          phTwoYear,
          phEpoch,
        ] = pointHistories
        expect(Number(formatEther(ph0.bias))).to.eq(0)
        expect(Number(formatEther(ph1.bias))).to.lt(400)
        expect(Number(formatEther(ph1.bias))).to.gte(380)
        expect(Number(formatEther(ph2.bias))).to.lt(200)
        expect(Number(formatEther(ph2.bias))).to.gte(180)
        expect(Number(formatEther(ph3.bias))).to.eq(0)
        expect(Number(formatEther(phBeforeOneYear.bias))).to.eq(0)
        expect(Number(formatEther(phOneYear.bias))).to.eq(0)
        expect(Number(formatEther(phBeforeTwoYear.bias))).to.eq(0)
        expect(Number(formatEther(phTwoYear.bias))).to.eq(0)
        expect(Number(formatEther(phEpoch.bias))).to.eq(0)

        // For Debug
        // for await (const ph of pointHistories) {
        //   console.log({
        //     bias: formatEther(ph.bias),
        //     slope: formatEther(ph.slope),
        //     ts: new Date(ph.ts.toNumber() * 1000).toISOString(),
        //     blk: ph.blk.toNumber(),
        //   })
        // }
      })

      it('if user increaseUnlockTime with 1 year', async () => {
        const { currentTs, votingEscrow, user } = await _execute()

        // Execute
        await (
          await votingEscrow.connect(user).increaseUnlockTime(1 * YEAR)
        ).wait()

        ethers.provider.send('evm_mine', [currentTs + 2 * YEAR])
        await (await votingEscrow.checkpoint()).wait()

        const epoch = (await votingEscrow.epoch()).toNumber()
        expect(epoch).to.eq(55)
        const pointHistories = await Promise.all([
          votingEscrow.pointHistory(0), // at deployed
          votingEscrow.pointHistory(1), // at the start (by createLock)
          votingEscrow.pointHistory(2), // at the start (by increaseAmount)
          votingEscrow.pointHistory(3),
          votingEscrow.pointHistory(26 + 2 - 1), // 1 year - 1
          votingEscrow.pointHistory(26 + 2), // 1 year
          votingEscrow.pointHistory(52 + 2 - 1), // 2 year - 1
          votingEscrow.pointHistory(52 + 2), // 2 year
          votingEscrow.pointHistory(epoch),
        ])
        const [
          ph0,
          ph1,
          ph2,
          ph3,
          phBeforeOneYear,
          phOneYear,
          phBeforeTwoYear,
          phTwoYear,
          phEpoch,
        ] = pointHistories
        expect(Number(formatEther(ph0.bias))).to.eq(0)
        expect(Number(formatEther(ph1.bias))).to.lt(400)
        expect(Number(formatEther(ph1.bias))).to.gte(380)
        expect(Number(formatEther(ph2.bias))).to.lt(5000)
        expect(Number(formatEther(ph2.bias))).to.gte(4950)
        expect(Number(formatEther(ph3.bias))).to.lt(4800 + 10)
        expect(Number(formatEther(ph3.bias))).to.gte(4750 + 10)
        expect(Number(formatEther(phBeforeOneYear.bias))).to.lt(200)
        expect(Number(formatEther(phBeforeOneYear.bias))).to.gte(180)
        expect(Number(formatEther(phOneYear.bias))).to.eq(0)
        expect(Number(formatEther(phBeforeTwoYear.bias))).to.eq(0)
        expect(Number(formatEther(phTwoYear.bias))).to.eq(0)
        expect(Number(formatEther(phEpoch.bias))).to.eq(0)
      })

      it('if user increaseUnlockTime with 2 year', async () => {
        const { currentTs, votingEscrow, user } = await _execute()

        // Execute
        await (
          await votingEscrow.connect(user).increaseUnlockTime(2 * YEAR)
        ).wait()

        ethers.provider.send('evm_mine', [currentTs + 2 * YEAR])
        await (await votingEscrow.checkpoint()).wait()

        const epoch = (await votingEscrow.epoch()).toNumber()
        expect(epoch).to.eq(55)
        const pointHistories = await Promise.all([
          votingEscrow.pointHistory(0), // at deployed
          votingEscrow.pointHistory(1), // at the start (by createLock)
          votingEscrow.pointHistory(2), // at the start (by increaseAmount)
          votingEscrow.pointHistory(3),
          votingEscrow.pointHistory(26 + 2 - 1), // 1 year - 1
          votingEscrow.pointHistory(26 + 2), // 1 year
          votingEscrow.pointHistory(52 + 2 - 1), // 2 year - 1
          votingEscrow.pointHistory(52 + 2), // 2 year
          votingEscrow.pointHistory(epoch),
        ])
        const [
          ph0,
          ph1,
          ph2,
          ph3,
          phBeforeOneYear,
          phOneYear,
          phBeforeTwoYear,
          phTwoYear,
          phEpoch,
        ] = pointHistories
        expect(Number(formatEther(ph0.bias))).to.eq(0)
        expect(Number(formatEther(ph1.bias))).to.lt(400)
        expect(Number(formatEther(ph1.bias))).to.gte(380)
        expect(Number(formatEther(ph2.bias))).to.lt(10000)
        expect(Number(formatEther(ph2.bias))).to.gte(9980)
        expect(Number(formatEther(ph3.bias))).to.lt(9800 + 10)
        expect(Number(formatEther(ph3.bias))).to.gte(9780 + 10)
        expect(Number(formatEther(phBeforeOneYear.bias))).to.lt(5200)
        expect(Number(formatEther(phBeforeOneYear.bias))).to.gte(5180)
        expect(Number(formatEther(phOneYear.bias))).to.lt(5000)
        expect(Number(formatEther(phOneYear.bias))).to.gte(4980)
        expect(Number(formatEther(phBeforeTwoYear.bias))).to.lt(200)
        expect(Number(formatEther(phBeforeTwoYear.bias))).to.gte(180)
        expect(Number(formatEther(phTwoYear.bias))).to.eq(0)
        expect(Number(formatEther(phEpoch.bias))).to.eq(0)
      })
    })
  })

  describe('Related locker id', () => {
    it('Generated locker id is incremental', async () => {
      const {
        users: [userA, userB, userC, userD, userE],
        oal,
        votingEscrow,
      } = await _setup({
        amount: parseEther('1'),
        count: 5,
      })
      let tx: ContractTransaction

      for await (let user of [userA, userB, userC, userD, userE]) {
        tx = await oal.connect(user).approve(votingEscrow.address, '1')
        await tx.wait()
        tx = await votingEscrow.connect(user).createLock('1', 2 * YEAR)
        await tx.wait()
      }

      const _ve = votingEscrow.connect(ethers.provider)
      expect((await _ve.ownerToId(userA.address)).toString()).to.eq('1')
      expect((await _ve.ownerToId(userB.address)).toString()).to.eq('2')
      expect((await _ve.ownerToId(userC.address)).toString()).to.eq('3')
      expect((await _ve.ownerToId(userD.address)).toString()).to.eq('4')
      expect((await _ve.ownerToId(userE.address)).toString()).to.eq('5')
    })

    describe('.locked', () => {
      describe('.end', () => {
        const BASE_LOCK_DURATION = 4 * TERM
        const AMOUNT = parseEther('100')

        const _setup = async () => {
          const results = await setup()
          await multiTransferOal({
            users: results.users,
            length: 1,
            amount: AMOUNT,
            oal: results.oal,
            holder: results.deployer,
          })
          return {
            user: results.users[0],
            oal: results.oal,
            votingEscrow: results.votingEscrow,
          }
        }

        const _locked = async (ve: VotingEscrow, address: string) => {
          const lockerId = (await ve.ownerToId(address)).toString()
          return await ve.locked(lockerId)
        }

        it('LockedBalance.end is after N term, if lockDuration is N term', async () => {
          const { user, oal, votingEscrow: ve } = await _setup()
          let tx: ContractTransaction

          // Prerequisites
          const currentTerm = await getCurrentTerm()
          const advancedCurrent = currentTerm + TERM
          ethers.provider.send('evm_mine', [advancedCurrent]) // Advance to the next term

          tx = await oal.connect(user).approve(ve.address, AMOUNT)
          await tx.wait()
          tx = await ve.connect(user).createLock(AMOUNT, BASE_LOCK_DURATION)
          await tx.wait()

          // Verification
          const locked = await _locked(ve, user.address)
          expect(locked.amount.toString()).to.eq(AMOUNT)
          expect(locked.end.toNumber()).to.eq(
            advancedCurrent + BASE_LOCK_DURATION
          )
        })

        it('LockedBalance.end is after N term, if lockDuration is N term + 1 day', async () => {
          const { user, oal, votingEscrow: ve } = await _setup()
          let tx: ContractTransaction

          // Prerequisites
          const currentTerm = await getCurrentTerm()
          const advancedCurrent = currentTerm + TERM
          ethers.provider.send('evm_mine', [advancedCurrent]) // Advance to the next term

          tx = await oal.connect(user).approve(ve.address, AMOUNT)
          await tx.wait()
          tx = await ve
            .connect(user)
            .createLock(AMOUNT, BASE_LOCK_DURATION + 1 * DAY)
          await tx.wait()

          // Verification
          const locked = await _locked(ve, user.address)
          expect(locked.amount.toString()).to.eq(AMOUNT)
          expect(locked.end.toNumber()).to.eq(
            advancedCurrent + BASE_LOCK_DURATION
          )
        })

        it('LockedBalance.end is after N-1 term, if lockDuration is N term - 1 day', async () => {
          const { user, oal, votingEscrow: ve } = await _setup()
          let tx: ContractTransaction

          // Prerequisites
          const currentTerm = await getCurrentTerm()
          const advancedCurrent = currentTerm + TERM
          ethers.provider.send('evm_mine', [advancedCurrent]) // Advance to the next term

          tx = await oal.connect(user).approve(ve.address, AMOUNT)
          await tx.wait()
          tx = await ve
            .connect(user)
            .createLock(AMOUNT, BASE_LOCK_DURATION - 1 * DAY)
          await tx.wait()

          // Verification
          const locked = await _locked(ve, user.address)
          expect(locked.amount.toString()).to.eq(AMOUNT)
          expect(locked.end.toNumber()).not.to.eq(
            advancedCurrent + BASE_LOCK_DURATION
          )
          expect(locked.end.toNumber()).to.eq(
            advancedCurrent + BASE_LOCK_DURATION - 1 * TERM
          )
        })
      })

      it('by multiple user', async () => {
        const {
          users: [userA, userB, userC],
          oal,
          votingEscrow,
        } = await _setup({
          amount: parseEther('500'),
          count: 5,
        })
        let tx: ContractTransaction
        const _current = Math.floor((await currentTimestamp()) / DAY) * DAY
        const current = _current + DAY
        ethers.provider.send('evm_mine', [_current]) // Advance to the next day

        const params = [
          { idx: 1, user: userA, amount: parseEther('5') },
          { idx: 2, user: userB, amount: parseEther('17') },
          { idx: 3, user: userC, amount: parseEther('128') },
        ]
        for await (const param of params) {
          tx = await oal
            .connect(param.user)
            .approve(votingEscrow.address, param.amount.toString())
          await tx.wait()
          tx = await votingEscrow
            .connect(param.user)
            .createLock(param.amount.toString(), 2 * YEAR)
          await tx.wait()
        }
        const afterTwoYear = current + 2 * YEAR
        for await (const param of params) {
          const locked = await votingEscrow.locked(param.idx)
          expect(locked.amount.toString()).to.eq(param.amount.toString())
          expect(locked.end.toNumber()).to.eq(
            Math.floor(afterTwoYear / TERM) * TERM // Locktime is rounded down to terms
          )
        }
      })

      it('multiple call from one user', async () => {
        const {
          users: [userA],
          oal,
          votingEscrow,
        } = await _setup({
          amount: parseEther('11100'),
          count: 1,
        })
        let tx: ContractTransaction
        tx = await oal
          .connect(userA)
          .approve(votingEscrow.address, ethers.constants.MaxUint256)
        await tx.wait()

        // First
        const first = parseEther('100')
        tx = await votingEscrow
          .connect(userA)
          .createLock(first.toString(), 2 * YEAR)
        await tx.wait()
        // - get lockerId after createLock
        const lockerId = (
          await votingEscrow.ownerToId(userA.address)
        ).toString()
        expect((await votingEscrow.locked(lockerId)).amount.toString()).to.eq(
          first.toString()
        )

        // Second
        const second = parseEther('1000')
        tx = await votingEscrow.connect(userA).increaseAmount(second.toString())
        await tx.wait()
        expect((await votingEscrow.locked(lockerId)).amount.toString()).to.eq(
          first.add(second).toString()
        )
        // Third
        const third = parseEther('10000')
        tx = await votingEscrow.connect(userA).increaseAmount(third.toString())
        await tx.wait()
        expect((await votingEscrow.locked(lockerId)).amount.toString()).to.eq(
          first.add(second).add(third).toString()
        )
      })
    })
  })

  describe('.addAgency, .removeAgency', () => {
    it('success', async () => {
      const {
        deployer: agency,
        votingEscrow: ve,
        users: [user],
      } = await setup()

      // Prerequisites
      const _ve = ve.connect(ethers.provider)
      expect(await _ve.agencies(agency.address)).to.eq(true)
      expect(await _ve.agencies(user.address)).to.eq(false)

      // Execute
      const AddTx = await ve.connect(agency).addAgency(user.address)
      await AddTx.wait()
      expect(await _ve.agencies(agency.address)).to.eq(true)
      expect(await _ve.agencies(user.address)).to.eq(true)

      const removeTx = await ve.connect(agency).removeAgency(user.address)
      await removeTx.wait()
      expect(await _ve.agencies(agency.address)).to.eq(true)
      expect(await _ve.agencies(user.address)).to.eq(false)
    })

    it('revert if not agency', async () => {
      const {
        deployer: agency,
        votingEscrow: ve,
        users: [user],
      } = await setup()

      // Prerequisites
      const _ve = ve.connect(ethers.provider)
      expect(await _ve.agencies(agency.address)).to.eq(true)
      expect(await _ve.agencies(user.address)).to.eq(false)

      // Execute
      await expect(ve.connect(user).addAgency(user.address)).to.be.revertedWith(
        'msg.sender is not agency'
      )
      await expect(
        ve.connect(user).removeAgency(agency.address)
      ).to.be.revertedWith('msg.sender is not agency')
    })
  })

  describe('.setVoter', () => {
    it('revert if not voter', async () => {
      const {
        votingEscrow,
        users: [user],
      } = await setup()

      // Prerequisites
      const voter = await votingEscrow.connect(ethers.provider).voter()
      expect(voter).not.to.eq(user.address)

      // Execute
      await expect(
        votingEscrow.connect(user).setVoter(user.address)
      ).to.be.revertedWith('msg.sender is not voter')
    })
    it('revert if zero address', async () => {
      const { votingEscrow, deployer } = await setup()

      // Execute
      await expect(
        votingEscrow.connect(deployer).setVoter(ethers.constants.AddressZero)
      ).to.be.revertedWith('Zero address cannot be set')
    })
  })

  describe('.voting', () => {
    it('revert if not voter', async () => {
      const {
        votingEscrow,
        users: [user],
      } = await setup()

      // Prerequisites
      const voter = await votingEscrow.connect(ethers.provider).voter()
      expect(voter).not.to.eq(user.address)

      // Execute
      await expect(votingEscrow.connect(user).voting(0)).to.be.revertedWith(
        'msg.sender is not voter'
      )
    })
  })

  describe('.abstain', () => {
    it('revert if not voter', async () => {
      const {
        votingEscrow,
        users: [user],
      } = await setup()

      // Prerequisites
      const voter = await votingEscrow.connect(ethers.provider).voter()
      expect(voter).not.to.eq(user.address)

      // Execute
      await expect(votingEscrow.connect(user).abstain(0)).to.be.revertedWith(
        'msg.sender is not voter'
      )
    })
  })

  describe('.createLockFor', () => {
    const AMOUNT = parseEther('1')
    const _setup = async () => {
      const results = await setup()
      await multiTransferOal({
        users: results.users,
        length: 1,
        amount: AMOUNT,
        oal: results.oal,
        holder: results.deployer,
      })
      const { deployer, users, oal, votingEscrow } = results
      return {
        deployer,
        users,
        oal,
        votingEscrow,
      }
    }

    it('success', async () => {
      const { deployer: agency, users, oal, votingEscrow: ve } = await _setup()
      let tx: ContractTransaction

      // Prerequisites
      const [_, lockTarget] = users
      expect(await ve.agencies(agency.address)).to.eq(true)
      expect((await ve.ownerToId(lockTarget.address)).toString()).to.eq('0')

      // Verification
      const AMOUNT = '1'
      tx = await oal.connect(agency).approve(ve.address, AMOUNT)
      await tx.wait()
      tx = await ve
        .connect(agency)
        .createLockFor(AMOUNT, 2 * YEAR, lockTarget.address)
      await tx.wait()
      const lockerId = await ve.ownerToId(lockTarget.address)
      expect(lockerId.toString()).not.to.eq('0')
      const lockedBalance = await ve.locked(lockerId.toString())
      expect(lockedBalance.amount.toString()).eq(AMOUNT)
    })

    it('revert if no agnecy', async () => {
      const { users, oal, votingEscrow: ve } = await _setup()
      let tx: ContractTransaction

      // Prerequisites
      const [notAgency, lockTarget] = users
      expect(await ve.agencies(notAgency.address)).to.eq(false)
      expect((await ve.ownerToId(lockTarget.address)).toString()).to.eq('0')

      // Verification
      tx = await oal.connect(notAgency).approve(ve.address, '1')
      await tx.wait()

      await expect(
        ve.connect(notAgency).createLockFor('1', 2 * YEAR, lockTarget.address)
      ).to.be.revertedWith('msg.sender is not agency')
      expect((await ve.ownerToId(lockTarget.address)).toString()).to.eq('0')
    })
  })

  describe('.increaseAmount', () => {
    it('revert if no locker', async () => {
      const { votingEscrow, deployer } = await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      await expect(
        votingEscrow.connect(deployer).increaseAmount('1')
      ).to.be.revertedWith('No lock associated with address')
    })
  })

  describe('.increaseUnlockTime', () => {
    it('revert if no locker', async () => {
      const { votingEscrow, deployer } = await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      await expect(
        votingEscrow.connect(deployer).increaseUnlockTime('1')
      ).to.be.revertedWith('No lock associated with address')
    })
  })

  describe('.withdraw', () => {
    it('revert if no locker', async () => {
      const { votingEscrow, deployer } = await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      await expect(
        votingEscrow.connect(deployer).withdraw()
      ).to.be.revertedWith('No lock associated with address')
    })
  })

  describe('.depositFor', () => {
    it('revert if no locker', async () => {
      const { votingEscrow, deployer, users } = await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      await expect(
        votingEscrow.connect(deployer).depositFor(users[0].address, '1')
      ).to.be.revertedWith('No lock associated with address')
    })
  })

  describe('Scenario: Point after update locking status', () => {
    describe('Check Point after .createLock with MAX lock duration', () => {
      let epoch: number
      let ve: VotingEscrow
      const LOCK_DURATION = 2 * YEAR
      const EPOCH_COUNT = 52 // term = 2 week -> 2year / 2week = 52
      before(async () => {
        const AMOUNT = parseEther('1')
        const { deployer, oal, votingEscrow } = await setup()
        let tx: ContractTransaction

        const _currentTerm = await getCurrentTerm()
        await ethers.provider.send('evm_mine', [_currentTerm + TERM])

        tx = await oal
          .connect(deployer)
          .approve(votingEscrow.address, ethers.constants.MaxUint256)
        await tx.wait()
        tx = await votingEscrow
          .connect(deployer)
          .createLock(AMOUNT, LOCK_DURATION)
        await tx.wait()
        epoch = Number(await votingEscrow.connect(ethers.provider).epoch())

        const currentTerm = await getCurrentTerm()
        await ethers.provider.send('evm_mine', [currentTerm + LOCK_DURATION])
        tx = await votingEscrow.connect(deployer).checkpoint()
        await tx.wait()

        ve = votingEscrow.connect(ethers.provider)
      })

      it('slope', async () => {
        const assumedSlope = 1 / (Math.floor(LOCK_DURATION / TERM) * TERM)
        const { slope: _actualSlope } = await ve.pointHistory(epoch)
        const actualSlope = Number(formatEther(_actualSlope))
        const relativeError = (assumedSlope - actualSlope) / actualSlope
        expect(relativeError).to.greaterThanOrEqual(-0.01 * 10 ** -8)
        expect(relativeError).to.lessThanOrEqual(0.01 * 10 ** -8)
      })

      it("current epoch's bias", async () => {
        const { bias } = await ve.pointHistory(epoch)
        expect(Number(formatEther(bias))).to.greaterThanOrEqual(0.99)
        expect(Number(formatEther(bias))).to.lessThan(1)
      })

      it("epoch's of 25% lock duration bias", async () => {
        const _epoch = epoch + EPOCH_COUNT * 0.25
        const { bias } = await ve.pointHistory(_epoch)
        expect(Number(formatEther(bias))).to.greaterThanOrEqual(0.74)
        expect(Number(formatEther(bias))).to.lessThan(0.75)
      })

      it("epoch's of 50% lock duration bias", async () => {
        const _epoch = epoch + EPOCH_COUNT * 0.5
        const { bias } = await ve.pointHistory(_epoch)
        expect(Number(formatEther(bias))).to.greaterThanOrEqual(0.49)
        expect(Number(formatEther(bias))).to.lessThan(0.5)
      })

      it("epoch's of 75% lock duration bias", async () => {
        const _epoch = epoch + EPOCH_COUNT * 0.75
        const { bias } = await ve.pointHistory(_epoch)
        expect(Number(formatEther(bias))).to.greaterThanOrEqual(0.24)
        expect(Number(formatEther(bias))).to.lessThan(0.25)
      })

      it("epoch's of (100% lock duration) - 1 bias", async () => {
        const _epoch = epoch + EPOCH_COUNT - 1
        const { bias } = await ve.pointHistory(_epoch)
        expect(Number(formatEther(bias))).to.to.greaterThan(0)
      })

      it("epoch's of 100% lock duration bias", async () => {
        const _epoch = epoch + EPOCH_COUNT
        const { bias } = await ve.pointHistory(_epoch)
        expect(Number(formatEther(bias))).to.eq(0)
      })

      it('N bias - N+1 bias = slope * time of a term', async () => {
        const baseEpoch = epoch + 1
        const { slope: curSlope, bias: curBias } = await ve.pointHistory(
          baseEpoch
        )
        const { slope: nextSlope, bias: nextBias } = await ve.pointHistory(
          baseEpoch + 1
        )
        const diffBias = curBias.sub(nextBias)
        expect(curSlope.eq(nextSlope)).to.be.true // if not added lock amount during this time
        expect(curSlope.mul(BigNumber.from(1 * TERM))).to.eq(diffBias)
      })
    })
  })
})
