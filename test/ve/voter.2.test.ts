import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { BigNumber, BigNumberish, Contract, ContractTransaction } from 'ethers'
import {
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
} from 'ethers/lib/utils'
import { ethers, upgrades } from 'hardhat'
import {
  ERC20__factory,
  MockLToken,
  MockLToken__factory,
  MockLendingPool__factory,
  Token,
  Token__factory,
  Voter,
  Voter__factory,
  VotingEscrow,
  VotingEscrow__factory,
} from '../../types'
import { DAY, getCurrentTerm, HOUR, MONTH, TERM, WEEK, YEAR } from './utils'

// Prepare
const setupMockLTokens = async (
  factory: MockLToken__factory
): Promise<string[]> => {
  const tokens = await Promise.all([
    factory.deploy('lWASTR', 'lWASTR'),
    factory.deploy('lWSDN', 'lWSDN'),
    factory.deploy('lWETH', 'lWETH'),
    factory.deploy('lWBTC', 'lWBTC'),
    factory.deploy('lUSDT', 'lUSDC'),
  ])
  for await (const token of tokens) {
    await token.deployTransaction.wait()
  }
  return tokens.map((t) => t.address)
}

const setupWithoutTokens = async () => {
  const [deployer, ...rest] = await ethers.getSigners()
  const oal = await new Token__factory(deployer).deploy(
    'OAL',
    'OAL',
    parseEther('100000'),
    await deployer.getAddress()
  )
  const lendingPool = await new MockLendingPool__factory(deployer).deploy()
  await oal.deployTransaction.wait()
  const votingEscrow = (await upgrades.deployProxy(
    new VotingEscrow__factory(deployer),
    [oal.address]
  )) as VotingEscrow
  await votingEscrow.deployTransaction.wait()
  const voter = (await upgrades.deployProxy(new Voter__factory(deployer), [
    lendingPool.address,
    votingEscrow.address,
  ])) as Voter
  await voter.deployTransaction.wait()

  // initialize
  const tx = await votingEscrow.setVoter(voter.address)
  await tx.wait()

  return {
    provider: ethers.provider,
    oal,
    votingEscrow,
    voter,
    deployer,
    users: rest,
    lendingPool,
  }
}

const setup = async () => {
  const results = await setupWithoutTokens()
  const { deployer, voter } = results

  // initialize
  const tokenAddresses = await setupMockLTokens(
    new MockLToken__factory(deployer)
  )

  for await (const token of tokenAddresses) {
    const tx = await voter.addToken(token)
    await tx.wait()
  }

  return {
    ...results,
    mockLTokenAddresses: tokenAddresses,
  }
}

describe('Voter.sol Part2', () => {
  describe('.initialize', () => {
    it('success', async () => {
      const { voter, votingEscrow, deployer } = await setup()
      const currentTerm = await getCurrentTerm()

      const [
        _ve,
        startTime,
        lastCheckpoint,
        termTimestampAtDeployed,
        minter,
        _term,
      ] = await Promise.all([
        voter._ve(),
        voter.START_TIME().then((v) => v.toNumber()),
        voter.lastCheckpoint().then((v) => v.toNumber()),
        voter.deployedTermTimestamp().then((v) => v.toNumber()),
        voter.minter(),
        voter.TERM(),
      ])
      expect(_ve.toLowerCase()).to.eq(votingEscrow.address.toLowerCase())
      expect(startTime).to.eq(currentTerm)
      expect(lastCheckpoint).to.eq(0)
      expect(termTimestampAtDeployed).to.eq(currentTerm)
      expect(minter).to.eq(deployer.address)
      expect(_term.toNumber()).to.eq(TERM)
    })
    it('revert if minter is zero address', async () => {
      const [deployer] = await ethers.getSigners()
      await expect(
        upgrades.deployProxy(new Voter__factory(deployer), [
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
        ])
      ).to.be.revertedWith('Zero address cannot be set')
    })
  })

  describe('.weights', () => {
    const _setupUntilCreatingLock = async () => {
      const amount = parseEther('1')
      const { oal, deployer, voter, votingEscrow, users, mockLTokenAddresses } =
        await setup()
      const [user] = users
      let tx: ContractTransaction
      tx = await oal.connect(deployer).transfer(user.address, amount)
      await tx.wait()
      tx = await oal.connect(user).approve(votingEscrow.address, amount)
      await tx.wait()
      tx = await votingEscrow.connect(user).createLock(amount, 2 * WEEK) // for decreasing computational complexity
      await tx.wait()
      const lockerId = (await votingEscrow.ownerToId(user.address)).toString()
      return {
        voter,
        lockerId,
        user,
        pools: mockLTokenAddresses,
      }
    }
    it('exist after votes', async () => {
      const { voter, user, lockerId, pools } = await _setupUntilCreatingLock()
      let tx: ContractTransaction
      // first votes
      const weights1 = [1, 0, 0, 0, 0]
      tx = await voter.connect(user).vote(weights1)
      await tx.wait()
      for (let i = 0; i < pools.length; i++) {
        const weight = await voter.weights(lockerId, pools[i])
        expect(Number(weight)).to.eq(weights1[i])
      }
      // update
      const weights2 = [0, 0, 1, 2, 3]
      tx = await voter.connect(user).vote(weights2)
      await tx.wait()
      for (let i = 0; i < pools.length; i++) {
        const weight = await voter.weights(lockerId, pools[i])
        expect(Number(weight)).to.eq(weights2[i])
      }
    })
    it('not exist before votes', async () => {
      const { voter, lockerId, pools } = await _setupUntilCreatingLock()
      for await (const p of pools) {
        const weight = await voter.weights(lockerId, p)
        expect(Number(weight)).to.eq(0)
      }
    })
  })

  describe('.checkpointToken', () => {
    describe('.lastCheckpoint after .checkpointToken', () => {
      const _setup = async () => {
        const { deployer, voter } = await setupWithoutTokens()
        const ltoken = await new MockLToken__factory(deployer).deploy(
          'LTOKEN',
          'LTOKEN'
        )
        await ltoken.deployTransaction.wait()
        // exec addToken
        await (await voter.addToken(ltoken.address)).wait()
        // exec mint to voter
        await (await ltoken.mint(voter.address, parseEther('1'))).wait()

        const startTerm = (await voter.START_TIME()).toNumber()
        return {
          voter,
          ltoken,
          startTerm,
        }
      }
      it('check prerequisites: initial tokensPerTerm is zero', async () => {
        const { voter, ltoken, startTerm } = await _setup()
        const [tokens0, tokens1] = await Promise.all([
          voter
            .tokensPerTerm(ltoken.address, startTerm)
            .then((v) => Number(formatEther(v))),
          voter
            .tokensPerTerm(ltoken.address, startTerm + TERM)
            .then((v) => Number(formatEther(v))),
        ])
        expect(tokens0).to.eq(0)
        expect(tokens1).to.eq(0)
      })
      it('not updated when initial term', async () => {
        const { voter, ltoken, startTerm } = await _setup()

        const currentTerm = (await voter.currentTermTimestamp()).toNumber()
        expect(currentTerm).to.eq(startTerm)
        const lastCheckpointBefore = (await voter.lastCheckpoint()).toNumber()
        expect(lastCheckpointBefore).to.eq(0)

        await (await voter.checkpointToken()).wait()

        const lastCheckpointAfter = (await voter.lastCheckpoint()).toNumber()
        expect(lastCheckpointAfter).to.gt(currentTerm)

        const [tokens0, tokens1] = await Promise.all([
          voter
            .tokensPerTerm(ltoken.address, startTerm)
            .then((v) => Number(formatEther(v))),
          voter
            .tokensPerTerm(ltoken.address, startTerm + TERM)
            .then((v) => Number(formatEther(v))),
        ])
        expect(tokens0).to.eq(0)
        expect(tokens1).to.eq(0)
      })
      it('not updated when initial term (just before next term)', async () => {
        const { voter, ltoken, startTerm } = await _setup()

        await ethers.provider.send('evm_mine', [startTerm + TERM - 5]) // 5 seconds before the next term
        await (await voter.checkpointToken()).wait()

        const lastCheckpoint = (await voter.lastCheckpoint()).toNumber()
        expect(lastCheckpoint).to.gt(startTerm)
        const [tokens0, tokens1] = await Promise.all([
          voter
            .tokensPerTerm(ltoken.address, startTerm)
            .then((v) => Number(formatEther(v))),
          voter
            .tokensPerTerm(ltoken.address, startTerm + TERM)
            .then((v) => Number(formatEther(v))),
        ])
        expect(tokens0).to.eq(0)
        expect(tokens1).to.eq(0)
      })
      it('updated when initial + 1 term', async () => {
        const { voter, ltoken, startTerm } = await _setup()

        await ethers.provider.send('evm_mine', [startTerm + TERM + 5])

        await (await voter.checkpointToken()).wait()

        const lastCheckpoint = (await voter.lastCheckpoint()).toNumber()
        expect(lastCheckpoint).to.greaterThan(startTerm + TERM)
        expect(lastCheckpoint).to.lessThanOrEqual(startTerm + TERM + 10)
        const [tokens0, tokens1] = await Promise.all([
          voter
            .tokensPerTerm(ltoken.address, startTerm)
            .then((v) => Number(formatEther(v))),
          voter
            .tokensPerTerm(ltoken.address, startTerm + TERM)
            .then((v) => Number(formatEther(v))),
        ])
        expect(tokens0).to.eq(0)
        expect(tokens1).to.eq(0)
      })
    })
  })

  describe('.tokenLastBalance', () => {
    const genAndAddToken = async (
      symbol: string,
      factory: MockLToken__factory,
      voter: Voter
    ): Promise<MockLToken> => {
      const ltoken = await factory.deploy(symbol, symbol)
      await ltoken.deployTransaction.wait()
      const tx = await voter.addToken(ltoken.address)
      await tx.wait()
      return ltoken
    }
    describe('normals', () => {
      it('only for holdings token increase after .checkpoint', async () => {
        const { deployer, voter } = await setupWithoutTokens()
        // Preparations
        const factory = new MockLToken__factory(deployer)
        const AToken = await genAndAddToken('ATOKEN', factory, voter)
        const BToken = await genAndAddToken('BTOKEN', factory, voter)
        const CToken = await genAndAddToken('CTOKEN', factory, voter)
        const DToken = await genAndAddToken('DTOKEN', factory, voter)
        const allTokens = [AToken, BToken, CToken, DToken]
        // - proceed time to skip initial term
        const _currentTerm = (await voter.currentTermTimestamp()).toNumber()
        ethers.provider.send('evm_mine', [_currentTerm + TERM + 1])
        // - check prerequisites
        for await (const t of allTokens) {
          const balance = await t.scaledBalanceOf(voter.address)
          expect(balance.isZero()).to.true

          const tIndex = (await voter.tokenIndex(t.address)).toNumber()
          const tLastBalance = await voter.tokenLastBalance(tIndex - 1)
          expect(tLastBalance.isZero()).to.true
        }

        // Execute
        const DECIMALS = 27
        const AMOUNT = parseUnits('123', DECIMALS)
        await (await CToken.mint(voter.address, AMOUNT)).wait()
        const balanceOf = await CToken.balanceOf(voter.address)
        const scaledBalanceOf = await CToken.scaledBalanceOf(voter.address)

        await (await voter.checkpointToken()).wait()

        // Check
        const cTIndex = (await voter.tokenIndex(CToken.address)).toNumber()
        const cTLastBalance = await voter.tokenLastBalance(cTIndex - 1)
        expect(cTLastBalance).to.eq(scaledBalanceOf)

        for await (const t of [AToken, BToken, DToken]) {
          const balance = await t.scaledBalanceOf(voter.address)
          expect(balance.isZero()).to.true

          const tIndex = (await voter.tokenIndex(t.address)).toNumber()
          const tLastBalance = await voter.tokenLastBalance(tIndex - 1)
          expect(tLastBalance.isZero()).to.true
        }
      })
      it('run .checkpoint multiple times', async () => {
        const { deployer, voter } = await setupWithoutTokens()
        // Preparations
        const factory = new MockLToken__factory(deployer)
        const addedTkn = await genAndAddToken('ADDEDTOKEN', factory, voter)
        const tIndex = (await voter.tokenIndex(addedTkn.address)).toNumber()
        const DECIMALS = 27
        // - proceed time to skip initial term
        const _currentTerm = (await voter.currentTermTimestamp()).toNumber()
        ethers.provider.send('evm_mine', [_currentTerm + TERM + 1])

        // Prerequisites
        const initialLastBalance = await voter.tokenLastBalance(tIndex - 1)
        expect(initialLastBalance.isZero()).to.true

        const execAndGetBalances = async (amount: BigNumber) => {
          await (await addedTkn.mint(voter.address, amount)).wait()
          await (await voter.checkpointToken()).wait()
          const scaledBalanceOf = await addedTkn.scaledBalanceOf(voter.address)
          const tokenLastBalance = await voter.tokenLastBalance(tIndex - 1)
          return {
            scaledBalanceOf,
            tokenLastBalance,
          }
        }

        // Execute 1
        const res1st = await execAndGetBalances(parseUnits('5678', DECIMALS))
        expect(res1st.tokenLastBalance).to.eq(res1st.scaledBalanceOf)

        // Execute 2
        const res2nd = await execAndGetBalances(parseUnits('12345', DECIMALS))
        expect(res2nd.tokenLastBalance).to.eq(res2nd.scaledBalanceOf)

        // Execute 3
        const res3rd = await execAndGetBalances(parseUnits('369', DECIMALS))
        expect(res3rd.tokenLastBalance).to.eq(res3rd.scaledBalanceOf)

        // Extra: multiple mint
        for await (const _a of ['1', '2', '3']) {
          const txMint = await addedTkn.mint(
            voter.address,
            parseUnits(_a, DECIMALS)
          )
          await txMint.wait()
        }
        await (await voter.checkpointToken()).wait()
        const scaledBalanceOf = await addedTkn.scaledBalanceOf(voter.address)
        const tokenLastBalance = await voter.tokenLastBalance(tIndex - 1)
        expect(tokenLastBalance).to.eq(scaledBalanceOf)
        // Extra: only checkpoint
        await (await voter.checkpointToken()).wait()
        const _tokenLastBalance = await voter.tokenLastBalance(tIndex - 1)
        expect(_tokenLastBalance).to.eq(scaledBalanceOf)
      })
    })
    describe('add/suspend/resume token', () => {
      const DECIMALS = 27
      let deployer: SignerWithAddress
      let voter: Voter
      let factory: MockLToken__factory
      let allTokens: MockLToken[]
      const mintedB = '123.45'
      const mintedC = '6.789'
      before(async () => {
        const { deployer: _deployer, voter: _voter } =
          await setupWithoutTokens()
        deployer = _deployer
        voter = _voter
        factory = new MockLToken__factory(deployer)
        const AToken = await genAndAddToken('ATOKEN', factory, voter)
        const BToken = await genAndAddToken('BTOKEN', factory, voter)
        const CToken = await genAndAddToken('CTOKEN', factory, voter)
        const DToken = await genAndAddToken('DTOKEN', factory, voter)
        allTokens = [AToken, BToken, CToken, DToken]

        // - proceed time to skip initial term
        const _currentTerm = (await voter.currentTermTimestamp()).toNumber()
        ethers.provider.send('evm_mine', [_currentTerm + TERM + 1])
      })

      let tokenLastBalances: { [key in string]: BigNumber }
      it('0. Prerequisites', async () => {
        const [AToken, BToken, CToken, DToken] = allTokens

        await (
          await BToken.mint(voter.address, parseUnits(mintedB, DECIMALS))
        ).wait()
        await (
          await CToken.mint(voter.address, parseUnits(mintedC, DECIMALS))
        ).wait()

        const [aBalance, bBalance, cBalance, dBalance] = await Promise.all([
          AToken.balanceOf(voter.address),
          BToken.balanceOf(voter.address),
          CToken.balanceOf(voter.address),
          DToken.balanceOf(voter.address),
        ])
        expect(aBalance).to.eq(BigNumber.from('0'))
        expect(bBalance).to.eq(parseUnits(mintedB, DECIMALS))
        expect(cBalance).to.eq(parseUnits(mintedC, DECIMALS))
        expect(dBalance).to.eq(BigNumber.from('0'))
        const [aScaled, bScaled, cScaled, dScaled] = await Promise.all([
          AToken.scaledBalanceOf(voter.address),
          BToken.scaledBalanceOf(voter.address),
          CToken.scaledBalanceOf(voter.address),
          DToken.scaledBalanceOf(voter.address),
        ])

        await (await voter.checkpointToken()).wait()

        tokenLastBalances = {
          AToken: await voter.tokenLastBalance(0),
          BToken: await voter.tokenLastBalance(1),
          CToken: await voter.tokenLastBalance(2),
          DToken: await voter.tokenLastBalance(3),
        }
        expect(tokenLastBalances.AToken).to.eq(aScaled)
        expect(tokenLastBalances.AToken).to.eq(BigNumber.from('0'))
        expect(tokenLastBalances.BToken).to.eq(bScaled)
        expect(tokenLastBalances.CToken).to.eq(cScaled)
        expect(tokenLastBalances.DToken).to.eq(dScaled)
        expect(tokenLastBalances.DToken).to.eq(BigNumber.from('0'))
      })
      it('1. exec .suspendToken', async () => {
        console.log('> 1. exec .suspendToken')
        const [AToken, BToken, CToken, DToken] = allTokens

        // Check: before
        const beforeParams = [
          {
            key: 'AToken',
            token: AToken,
            tokenIndex: 1,
          },
          {
            key: 'BToken',
            token: BToken,
            tokenIndex: 2,
          },
          {
            key: 'CToken',
            token: CToken,
            tokenIndex: 3,
          },
          {
            key: 'DToken',
            token: DToken,
            tokenIndex: 4,
          },
        ]
        for await (const [i, p] of beforeParams.entries()) {
          const idx = (await voter.tokenIndex(p.token.address)).toNumber()
          expect(idx).to.eq(p.tokenIndex)
          console.log(
            `${p.key}: ${p.tokenIndex}: ${formatUnits(
              tokenLastBalances[beforeParams[i].key],
              27
            )}`
          )
        }

        // Execute: supending AToken
        await (await voter.suspendToken(AToken.address)).wait()

        // Check: after supending AToken
        const after1Params = [
          { key: 'AToken', token: AToken, tokenIndex: 0 },
          { key: 'BToken', token: BToken, tokenIndex: 1 },
          { key: 'CToken', token: CToken, tokenIndex: 2 },
          { key: 'DToken', token: DToken, tokenIndex: 3 },
        ]
        for await (const [i, p] of after1Params.entries()) {
          const idx = (await voter.tokenIndex(p.token.address)).toNumber()
          expect(idx).to.eq(p.tokenIndex)
          if (p.tokenIndex == 0) continue
          const tokenLastBalance = await voter.tokenLastBalance(
            p.tokenIndex - 1
          )
          console.log(
            `${p.key}: ${p.tokenIndex}: ${formatUnits(tokenLastBalance, 27)}`
          )
          expect(tokenLastBalance).to.eq(tokenLastBalances[beforeParams[i].key])
        }

        // Execute: supending BToken
        await (await voter.suspendToken(BToken.address)).wait()

        // Check: after supending BToken
        const after2Params = [
          { key: 'AToken', token: AToken, tokenIndex: 0 },
          { key: 'BToken', token: BToken, tokenIndex: 0 },
          { key: 'CToken', token: CToken, tokenIndex: 1 },
          { key: 'DToken', token: DToken, tokenIndex: 2 },
        ]
        for await (const [i, p] of after2Params.entries()) {
          const idx = (await voter.tokenIndex(p.token.address)).toNumber()
          expect(idx).to.eq(p.tokenIndex)
          if (p.tokenIndex == 0) continue
          const tokenLastBalance = await voter.tokenLastBalance(
            p.tokenIndex - 1
          )
          console.log(
            `${p.key}: ${p.tokenIndex}: ${formatUnits(tokenLastBalance, 27)}`
          )
          expect(tokenLastBalance).to.eq(tokenLastBalances[beforeParams[i].key])
        }
      })
      it('2. exec .resumeToken', async () => {
        console.log('> 2. exec .resumeToken')
        const [AToken, BToken, CToken, DToken] = allTokens

        // Execute: resume BToken -> AToken
        await (await voter.resumeToken(BToken.address)).wait()
        await (await voter.resumeToken(AToken.address)).wait()

        // Check
        const params = [
          { key: 'AToken', token: AToken, tokenIndex: 4 },
          { key: 'BToken', token: BToken, tokenIndex: 3 },
          { key: 'CToken', token: CToken, tokenIndex: 1 },
          { key: 'DToken', token: DToken, tokenIndex: 2 },
        ]
        for await (const [i, p] of params.entries()) {
          const idx = (await voter.tokenIndex(p.token.address)).toNumber()
          expect(idx).to.eq(p.tokenIndex)
          const tokenLastBalance = await voter.tokenLastBalance(
            p.tokenIndex - 1
          )
          expect(tokenLastBalance).to.eq(tokenLastBalances[params[i].key])
        }
      })
    })
    describe('not distribute to initial term (voting is not available)', () => {
      const __setup = async () => {
        const _currentTerm = await getCurrentTerm()
        await ethers.provider.send('evm_mine', [_currentTerm + TERM + 1]) // just after at the term starting

        const { deployer, voter } = await setupWithoutTokens()

        const factory = new MockLToken__factory(deployer)
        const mockToken = await genAndAddToken('MOCK_TOKEN', factory, voter)

        const initialTerm = (await voter.currentTermTimestamp()).toNumber()
        const term1st = initialTerm + TERM
        const term2nd = initialTerm + 2 * TERM
        const term3rd = initialTerm + 3 * TERM

        const getTokenPerWeeks = async () => {
          const results = await Promise.all([
            voter
              .tokensPerTerm(mockToken.address, initialTerm)
              .then((v) => Number(formatEther(v))),
            voter
              .tokensPerTerm(mockToken.address, term1st)
              .then((v) => Number(formatEther(v))),
            voter
              .tokensPerTerm(mockToken.address, term2nd)
              .then((v) => Number(formatEther(v))),
            voter
              .tokensPerTerm(mockToken.address, term3rd)
              .then((v) => Number(formatEther(v))),
          ])
          return {
            initial: results[0],
            first: results[1],
            second: results[2],
            third: results[3],
          }
        }

        return {
          voter,
          getTokenPerWeeks,
          mockToken,
          terms: {
            first: term1st,
            second: term2nd,
            third: term3rd,
          },
        }
      }
      it('mint/checkpoint when just after at the starting term', async () => {
        const { voter, getTokenPerWeeks, mockToken, terms } = await __setup()

        await await mockToken.mint(voter.address, parseEther('1'))
        await (await voter.checkpointToken()).wait()
        const res = await getTokenPerWeeks()
        expect(res.initial).to.eq(0)
        expect(res.first).to.eq(0)
        expect(res.second).to.eq(0)
        expect(res.third).to.eq(0)

        await ethers.provider.send('evm_mine', [terms.first])

        await await mockToken.mint(voter.address, parseEther('2'))
        await (await voter.checkpointToken()).wait()
        const res1st = await getTokenPerWeeks()
        expect(res1st.initial).to.gt(1.5)
        expect(res1st.first).to.lessThanOrEqual(3)
        expect(res1st.first).to.gt(0)
        expect(res1st.second).to.eq(0)
        expect(res1st.third).to.eq(0)

        await ethers.provider.send('evm_mine', [terms.second])

        await await mockToken.mint(voter.address, parseEther('3'))
        await (await voter.checkpointToken()).wait()
        const res2nd = await getTokenPerWeeks()
        expect(res2nd.initial).to.gt(0)
        expect(res2nd.first).to.lessThanOrEqual(6)
        expect(res2nd.first).to.greaterThanOrEqual(2)
        expect(res2nd.second).to.greaterThan(0)
        expect(res2nd.third).to.eq(0)

        await ethers.provider.send('evm_mine', [terms.third])

        await await mockToken.mint(voter.address, parseEther('4'))
        await (await voter.checkpointToken()).wait()
        const res3rd = await getTokenPerWeeks()
        expect(res3rd.initial).to.gt(1)
        expect(res3rd.first).to.lessThanOrEqual(6)
        expect(res3rd.first).to.greaterThanOrEqual(2.9)
        expect(res3rd.second).to.lessThanOrEqual(4)
        expect(res3rd.second).to.greaterThanOrEqual(3.9)
        expect(res3rd.third).to.greaterThan(0)
      })
      it('mint/checkpoint when just before at the end term', async () => {
        const { voter, getTokenPerWeeks, mockToken, terms } = await __setup()

        await ethers.provider.send('evm_mine', [terms.first - 0.25 * HOUR]) // = initial term

        await await mockToken.mint(voter.address, parseEther('1'))
        await (await voter.checkpointToken()).wait()
        const res = await getTokenPerWeeks()
        expect(res.initial).to.eq(0)
        expect(res.first).to.eq(0)
        expect(res.second).to.eq(0)
        expect(res.third).to.eq(0)

        await ethers.provider.send('evm_mine', [terms.second - 0.25 * HOUR]) // = 1st term

        await await mockToken.mint(voter.address, parseEther('2'))
        await (await voter.checkpointToken()).wait()
        const res1st = await getTokenPerWeeks()
        expect(res1st.initial).to.gt(0)
        expect(res1st.first).to.lessThanOrEqual(3)
        expect(res1st.first).to.gt(1.9)
        expect(res1st.second).to.eq(0)
        expect(res1st.third).to.eq(0)

        await ethers.provider.send('evm_mine', [terms.third - 0.25 * HOUR]) // = 2nd term

        await await mockToken.mint(voter.address, parseEther('3'))
        await (await voter.checkpointToken()).wait()
        const res2nd = await getTokenPerWeeks()
        expect(res2nd.initial).to.gt(0)
        expect(res2nd.first).to.lessThanOrEqual(3)
        expect(res2nd.first).to.greaterThanOrEqual(1)
        expect(res2nd.second).to.lessThanOrEqual(3)
        expect(res2nd.second).to.greaterThanOrEqual(2.9)
        expect(res2nd.third).to.eq(0)

        await ethers.provider.send('evm_mine', [
          terms.third + TERM - 0.25 * HOUR,
        ]) // = 3rd term

        await await mockToken.mint(voter.address, parseEther('4'))
        await (await voter.checkpointToken()).wait()
        const res3rd = await getTokenPerWeeks()
        expect(res3rd.initial).to.gt(0)
        expect(res3rd.first).to.lessThanOrEqual(3)
        expect(res3rd.first).to.greaterThanOrEqual(1.9)
        expect(res3rd.second).to.lessThanOrEqual(3)
        expect(res3rd.second).to.greaterThanOrEqual(2.9)
        expect(res3rd.third).to.lessThanOrEqual(4)
        expect(res3rd.third).to.greaterThanOrEqual(3.9)
      })
    })
  })

  describe('.setMinter', () => {
    it('success', async () => {
      const {
        voter,
        deployer,
        users: [user],
      } = await setup()

      // Prerequisites
      expect((await voter.minter()).toLowerCase()).to.eq(
        deployer.address.toLowerCase()
      )

      // Execute
      const tx = await voter.connect(deployer).setMinter(user.address)
      await tx.wait()
      expect((await voter.minter()).toLowerCase()).to.eq(
        user.address.toLowerCase()
      )
    })
    it('revert if not minter', async () => {
      const {
        voter,
        users: [notMinter],
      } = await setup()

      // Prerequisites
      expect((await voter.minter()).toLowerCase()).not.to.eq(
        notMinter.address.toLowerCase()
      )

      // Execute
      await expect(
        voter.connect(notMinter).setMinter(notMinter.address)
      ).to.be.revertedWith('Not the minter address')
    })
    it('revert if zero address', async () => {
      const { voter, deployer: minter } = await setup()

      // Execute
      await expect(
        voter.connect(minter).setMinter(ethers.constants.AddressZero)
      ).to.be.revertedWith('Zero address cannot be set')
    })
  })

  describe('.addToken', () => {
    it('success', async () => {
      const { voter, deployer: minter, mockLTokenAddresses } = await setup()
      const beforeLength = mockLTokenAddresses.length

      // Prerequisites
      const dummyToken = await new MockLToken__factory(minter).deploy('t', 'T')
      await dummyToken.deployTransaction.wait()
      const _minter = await voter.minter()
      expect(_minter.toLowerCase()).to.eq(minter.address.toLowerCase())
      expect((await voter.tokenList()).length).to.eq(beforeLength)
      expect((await voter.tokenIndex(dummyToken.address)).toNumber()).to.eq(0)

      // Execute
      const tx = await voter.connect(minter).addToken(dummyToken.address)
      await tx.wait()
      expect((await voter.tokenList()).length).to.eq(beforeLength + 1)
      expect((await voter.tokenIndex(dummyToken.address)).toNumber()).to.eq(
        beforeLength + 1
      )
    })
    it('revert if second time', async () => {
      const { voter, deployer: minter } = await setup()

      // Prerequisites
      const dummyToken = await new MockLToken__factory(minter).deploy('t', 'T')
      await dummyToken.deployTransaction.wait()
      await (await voter.connect(minter).addToken(dummyToken.address)).wait()

      // Execute
      await expect(
        voter.connect(minter).addToken(dummyToken.address)
      ).to.be.revertedWith('Already whitelisted')
    })
    it('revert if not minter', async () => {
      const {
        voter,
        users: [user, dummyToken],
      } = await setup()

      // Prerequisites
      const minter = await voter.minter()
      expect(minter).not.to.eq(user.address)

      // Execute
      await expect(
        voter.connect(user).addToken(dummyToken.address)
      ).to.be.revertedWith('Not the minter address')
    })
    it('revert if zero address', async () => {
      const { voter, deployer: minter } = await setup()

      // Execute
      await expect(
        voter.connect(minter).addToken(ethers.constants.AddressZero)
      ).to.be.revertedWith('Zero address cannot be set')
    })
    describe('check whether ltoken or not', () => {
      let voter: Voter
      let others: Contract[]
      let deployer: SignerWithAddress
      let users: SignerWithAddress[]
      const revertMsg = '_token is not ltoken'
      before(async () => {
        const {
          voter: _voter,
          oal,
          votingEscrow,
          deployer: _deployer,
          users: _users,
        } = await setup()
        voter = _voter.connect(_deployer)
        others = [oal, votingEscrow]
        deployer = _deployer
        users = _users
      })
      it('success', async () => {
        const token = await new MockLToken__factory(deployer).deploy('t', 'T')
        await token.deployTransaction.wait()

        const tx = await voter.addToken(token.address)
        await tx.wait()

        const index = await voter.tokenIndex(token.address)
        expect(index.toNumber()).to.gt(0)
      })
      it('revert if eoa', async () => {
        await expect(voter.addToken(deployer.address)).to.be.revertedWith(
          revertMsg
        )
        await expect(voter.addToken(users[0].address)).to.be.revertedWith(
          revertMsg
        )
        await expect(voter.addToken(users[1].address)).to.be.revertedWith(
          revertMsg
        )
      })
      it('revert if other contract', async () => {
        await expect(voter.addToken(others[0].address)).to.be.revertedWith(
          revertMsg
        )
        await expect(voter.addToken(others[1].address)).to.be.revertedWith(
          revertMsg
        )
      })
      it('revert if normal ERC20', async () => {
        const token = await new ERC20__factory(deployer).deploy('t', 'T')
        await token.deployTransaction.wait()

        await expect(voter.addToken(token.address)).to.be.revertedWith(
          revertMsg
        )
      })
    })
  })

  describe('.suspendToken, .resumeToken', () => {
    const _setup = async () => {
      const { deployer, voter, users } = await setupWithoutTokens()
      const factory = new MockLToken__factory(deployer)
      return { voter, factory, users }
    }
    describe('success', () => {
      it('.suspendToken -> .resumeToken', async () => {
        const { voter, factory } = await _setup()
        let tx: ContractTransaction
        const { AddressZero } = ethers.constants

        // Prerequisites
        const tokens = await Promise.all([
          factory.deploy('lWASTR', 'lWASTR'),
          factory.deploy('lWSDN', 'lWSDN'),
          factory.deploy('lWETH', 'lWETH'),
          factory.deploy('lWBTC', 'lWBTC'),
          factory.deploy('lUSDT', 'lUSDT'),
        ])
        for await (const token of tokens) {
          await token.deployTransaction.wait()
          const tx = await voter.addToken(token.address)
          await tx.wait()
        }
        const [wastr, wsdn, weth, wbtc, usdt] = tokens
        const usdc = await factory.deploy('lUSDC', 'lUSDC')
        await usdc.deployTransaction.wait()
        expect((await voter.tokenIndex(wastr.address)).toNumber()).to.eq(1)
        expect((await voter.tokenIndex(wsdn.address)).toNumber()).to.eq(2)
        expect((await voter.tokenIndex(weth.address)).toNumber()).to.eq(3)
        expect((await voter.tokenIndex(wbtc.address)).toNumber()).to.eq(4)
        expect((await voter.tokenIndex(usdt.address)).toNumber()).to.eq(5)
        expect((await voter.tokenIndex(usdc.address)).toNumber()).to.eq(0)
        for await (const token of tokens) {
          expect(await voter.isWhitelisted(token.address)).to.eq(true)
          expect(await voter.isSuspended(token.address)).to.eq(false)
        }

        // Execute .suspendToken
        tx = await voter.suspendToken(wsdn.address)
        await tx.wait()
        //   Check
        expect((await voter.tokenIndex(wastr.address)).toNumber()).to.eq(1)
        expect((await voter.tokenIndex(wsdn.address)).toNumber()).to.eq(0)
        expect((await voter.tokenIndex(weth.address)).toNumber()).to.eq(2)
        expect((await voter.tokenIndex(wbtc.address)).toNumber()).to.eq(3)
        expect((await voter.tokenIndex(usdt.address)).toNumber()).to.eq(4)
        expect((await voter.tokenIndex(usdc.address)).toNumber()).to.eq(0)
        const rests = [wastr, weth, wbtc, usdt]
        for await (const token of rests) {
          expect(await voter.isWhitelisted(token.address)).to.eq(true)
          expect(await voter.isSuspended(token.address)).to.eq(false)
        }
        expect(await voter.isWhitelisted(wsdn.address)).to.eq(true)
        expect(await voter.isSuspended(wsdn.address)).to.eq(true)

        // Execute .resumeToken
        tx = await voter.resumeToken(wsdn.address)
        await tx.wait()
        //   Check
        expect((await voter.tokenIndex(wsdn.address)).toNumber()).to.eq(5)
        expect((await voter.tokenIndex(wastr.address)).toNumber()).to.eq(1)
        expect((await voter.tokenIndex(weth.address)).toNumber()).to.eq(2)
        expect((await voter.tokenIndex(wbtc.address)).toNumber()).to.eq(3)
        expect((await voter.tokenIndex(usdt.address)).toNumber()).to.eq(4)
        expect((await voter.tokenIndex(usdc.address)).toNumber()).to.eq(0)
        for await (const token of tokens) {
          expect(await voter.isWhitelisted(token.address)).to.eq(true)
          expect(await voter.isSuspended(token.address)).to.eq(false)
        }
      })
    })
    describe('fail in .suspendToken', () => {
      let ltoken: MockLToken
      before(async () => {
        const [deployer] = await ethers.getSigners()
        ltoken = await new MockLToken__factory(deployer).deploy('l', 'L')
      })
      it('revert if not minter', async () => {
        const {
          voter,
          users: [notMinter],
        } = await _setup()
        await expect(
          voter.connect(notMinter).suspendToken(ltoken.address)
        ).to.be.revertedWith('Not the minter address')
      })
      it('revert if zero address', async () => {
        const { voter } = await _setup()
        await expect(
          voter.suspendToken(ethers.constants.AddressZero)
        ).to.be.revertedWith('Zero address cannot be set')
      })
      it('revert if not whitelisted', async () => {
        const { voter } = await _setup()
        await expect(voter.suspendToken(ltoken.address)).to.be.revertedWith(
          'Not whitelisted yet'
        )
      })
      it('revert if suspended', async () => {
        const { voter } = await _setup()
        let tx: ContractTransaction

        // Prerequisites
        tx = await voter.addToken(ltoken.address)
        await tx.wait()
        tx = await voter.suspendToken(ltoken.address)
        await tx.wait()

        // Execute
        await expect(voter.suspendToken(ltoken.address)).to.be.revertedWith(
          '_token is suspended'
        )
      })
    })
    describe('fail in .resumeToken', () => {
      let ltoken: MockLToken
      before(async () => {
        const [deployer] = await ethers.getSigners()
        ltoken = await new MockLToken__factory(deployer).deploy('l', 'L')
      })
      it('revert if not minter', async () => {
        const {
          voter,
          users: [notMinter],
        } = await _setup()
        await expect(
          voter.connect(notMinter).resumeToken(ltoken.address)
        ).to.be.revertedWith('Not the minter address')
      })
      it('revert if zero address', async () => {
        const { voter } = await _setup()
        await expect(
          voter.resumeToken(ethers.constants.AddressZero)
        ).to.be.revertedWith('Zero address cannot be set')
      })
      it('revert if not whitelisted', async () => {
        const { voter } = await _setup()
        await expect(voter.resumeToken(ltoken.address)).to.be.revertedWith(
          'Not suspended yet'
        )
      })
      it('revert if not suspended', async () => {
        const { voter } = await _setup()
        let tx: ContractTransaction

        // Prerequisites
        tx = await voter.addToken(ltoken.address)
        await tx.wait()

        // Execute
        await expect(voter.resumeToken(ltoken.address)).to.be.revertedWith(
          'Not suspended yet'
        )
      })
      it('revert if not suspended (resumed once)', async () => {
        const { voter } = await _setup()
        let tx: ContractTransaction

        // Prerequisites
        tx = await voter.addToken(ltoken.address)
        await tx.wait()
        tx = await voter.suspendToken(ltoken.address)
        await tx.wait()
        tx = await voter.resumeToken(ltoken.address)
        await tx.wait()

        // Execute
        await expect(voter.resumeToken(ltoken.address)).to.be.revertedWith(
          'Not suspended yet'
        )
      })
    })
  })

  describe('.vote', () => {
    describe('check lock term', () => {
      describe('lock duration > maxVoteDuration', () => {
        const AMOUNT = parseEther('0.01')
        const LOCK_DURATION = 2 * YEAR
        let _voter: Voter
        let lockerId: string
        let weights: string[]
        before(async () => {
          const {
            oal,
            voter,
            votingEscrow,
            deployer,
            users: [user],
            mockLTokenAddresses,
          } = await setup()
          let tx: ContractTransaction

          // Prerequisites
          tx = await oal.connect(deployer).transfer(user.address, AMOUNT)
          await tx.wait()
          tx = await oal.connect(user).approve(votingEscrow.address, AMOUNT)
          await tx.wait()
          tx = await votingEscrow
            .connect(user)
            .createLock(AMOUNT, LOCK_DURATION)
          await tx.wait()

          _voter = voter.connect(user)
          lockerId = (await votingEscrow.ownerToId(user.address)).toString()
          weights = [...Array(mockLTokenAddresses.length)].map((_, i) =>
            i == 0 ? '1' : '0'
          )
        })
        it('vote duration is maxVoteDuration by .vote', async () => {
          // Execute
          let tx: ContractTransaction
          tx = await _voter.vote(weights)
          await tx.wait()
          const voteEndTime = (await _voter.voteEndTime(lockerId)).toNumber()

          const current = await (
            await ethers.provider.getBlock(
              await ethers.provider.getBlockNumber()
            )
          ).timestamp
          const maxVoteDuration = (await _voter.MAX_VOTE_DURATION()).toNumber()
          expect(current + maxVoteDuration).to.eq(voteEndTime)
        })
        it('.voteUntil (= maxVoteDuration)', async () => {
          // Execute
          let tx: ContractTransaction
          const current = await (
            await ethers.provider.getBlock(
              await ethers.provider.getBlockNumber()
            )
          ).timestamp
          const maxVoteDuration = (await _voter.MAX_VOTE_DURATION()).toNumber()
          tx = await _voter.voteUntil(weights, current + maxVoteDuration)
          await tx.wait()
          const voteEndTime = (await _voter.voteEndTime(lockerId)).toNumber()
          expect(current + maxVoteDuration).to.eq(voteEndTime)
        })
        it('.voteUntil (< maxVoteDuration)', async () => {
          // Execute
          let tx: ContractTransaction
          const current = await (
            await ethers.provider.getBlock(
              await ethers.provider.getBlockNumber()
            )
          ).timestamp
          const maxVoteDuration = (await _voter.MAX_VOTE_DURATION()).toNumber()
          const lockDuration = maxVoteDuration / 3
          tx = await _voter.voteUntil(weights, current + lockDuration)
          await tx.wait()
          const voteEndTime = (await _voter.voteEndTime(lockerId)).toNumber()

          expect(current + lockDuration).to.eq(voteEndTime)
        })
        it('.voteUntil (> maxVoteDuration)', async () => {
          // Execute
          let tx: ContractTransaction
          const current = await (
            await ethers.provider.getBlock(
              await ethers.provider.getBlockNumber()
            )
          ).timestamp
          const maxVoteDuration = (await _voter.MAX_VOTE_DURATION()).toNumber()
          await expect(
            _voter.voteUntil(weights, current + maxVoteDuration + 0.1 * HOUR)
          ).to.be.revertedWith('Over max vote end timestamp')
        })
      })
      describe('lock duration < maxVoteDuration', () => {
        const AMOUNT = parseEther('0.01')
        const LOCK_DURATION = 1 * MONTH
        let _voter: Voter
        let lockerId: string
        let weights: string[]
        before(async () => {
          const {
            oal,
            voter,
            votingEscrow,
            deployer,
            users: [user],
            mockLTokenAddresses,
          } = await setup()
          let tx: ContractTransaction

          // Prerequisites
          tx = await oal.connect(deployer).transfer(user.address, AMOUNT)
          await tx.wait()
          tx = await oal.connect(user).approve(votingEscrow.address, AMOUNT)
          await tx.wait()
          tx = await votingEscrow
            .connect(user)
            .createLock(AMOUNT, LOCK_DURATION)
          await tx.wait()

          _voter = voter.connect(user)
          lockerId = (await votingEscrow.ownerToId(user.address)).toString()
          weights = [...Array(mockLTokenAddresses.length)].map((_, i) =>
            i == 0 ? '1' : '0'
          )
        })
        it('vote duration is maxLockDuration by .vote', async () => {
          // Execute
          let tx: ContractTransaction
          tx = await _voter.vote(weights)
          await tx.wait()
          const voteEndTime = (await _voter.voteEndTime(lockerId)).toNumber()

          const current = await (
            await ethers.provider.getBlock(
              await ethers.provider.getBlockNumber()
            )
          ).timestamp
          const actual = Math.floor((current + LOCK_DURATION) / TERM) * TERM // rounded by term
          expect(actual).to.eq(voteEndTime)
        })
      })
    })
    it('revert if no locker', async () => {
      const { voter, votingEscrow, deployer, mockLTokenAddresses } =
        await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      const _weights = [...Array(mockLTokenAddresses.length)].map((_) => '1')
      await expect(voter.connect(deployer).vote(_weights)).to.be.revertedWith(
        'No lock associated with address'
      )
    })
  })

  describe('.voteUntil', () => {
    const AMOUNT = parseEther('1.00')
    const LOCK_DURATION = 2 * YEAR
    const __setup = async () => {
      const {
        oal,
        voter,
        votingEscrow,
        deployer,
        users: [user],
        mockLTokenAddresses,
      } = await setup()
      let tx: ContractTransaction

      // Prerequisites
      tx = await oal.connect(deployer).transfer(user.address, AMOUNT)
      await tx.wait()
      tx = await oal.connect(user).approve(votingEscrow.address, AMOUNT)
      await tx.wait()
      tx = await votingEscrow.connect(user).createLock(AMOUNT, LOCK_DURATION)
      await tx.wait()
      const currentTerm = (await voter.currentTermTimestamp()).toNumber()

      return {
        voter: voter.connect(user),
        lockerId: (await votingEscrow.ownerToId(user.address)).toString(),
        weights: [...Array(mockLTokenAddresses.length)].map((_, i) =>
          i == 0 ? '1' : '0'
        ),
        currentTerm,
      }
    }

    it('when N * term - 1', async () => {
      const { voter, lockerId, weights, currentTerm } = await __setup()
      const duration = 3 * TERM - 1
      await (await voter.voteUntil(weights, currentTerm + duration)).wait()
      const results = await Promise.all([
        voter
          .votedTotalVotingWeights(lockerId, currentTerm)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 1 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 2 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 3 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 4 * TERM)
          .then((v) => Number(formatEther(v))),
      ])
      expect(results[0]).to.eq(0)
      expect(results[1]).to.greaterThan(0)
      expect(results[2]).to.greaterThan(0)
      expect(results[3]).to.eq(0)
      expect(results[4]).to.eq(0)
    })
    it('when N * term', async () => {
      const { voter, lockerId, weights, currentTerm } = await __setup()
      const duration = 3 * TERM
      await (await voter.voteUntil(weights, currentTerm + duration)).wait()
      const results = await Promise.all([
        voter
          .votedTotalVotingWeights(lockerId, currentTerm)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 1 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 2 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 3 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 4 * TERM)
          .then((v) => Number(formatEther(v))),
      ])
      expect(results[0]).to.eq(0)
      expect(results[1]).to.greaterThan(0)
      expect(results[2]).to.greaterThan(0)
      expect(results[3]).to.greaterThan(0)
      expect(results[4]).to.eq(0)
    })
    it('when N * term + 1', async () => {
      const { voter, lockerId, weights, currentTerm } = await __setup()
      const duration = 3 * TERM
      await (await voter.voteUntil(weights, currentTerm + duration)).wait()
      const results = await Promise.all([
        voter
          .votedTotalVotingWeights(lockerId, currentTerm)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 1 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 2 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 3 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 4 * TERM)
          .then((v) => Number(formatEther(v))),
      ])
      expect(results[0]).to.eq(0)
      expect(results[1]).to.greaterThan(0)
      expect(results[2]).to.greaterThan(0)
      expect(results[3]).to.greaterThan(0)
      expect(results[4]).to.eq(0)
    })
    it('when N * term + (term - 1)', async () => {
      const { voter, lockerId, weights, currentTerm } = await __setup()
      const duration = 3 * TERM
      await (await voter.voteUntil(weights, currentTerm + duration)).wait()
      const results = await Promise.all([
        voter
          .votedTotalVotingWeights(lockerId, currentTerm)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 1 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 2 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 3 * TERM)
          .then((v) => Number(formatEther(v))),
        voter
          .votedTotalVotingWeights(lockerId, currentTerm + 4 * TERM)
          .then((v) => Number(formatEther(v))),
      ])
      expect(results[0]).to.eq(0)
      expect(results[1]).to.greaterThan(0)
      expect(results[2]).to.greaterThan(0)
      expect(results[3]).to.greaterThan(0)
      expect(results[4]).to.eq(0)
    })
  })

  describe('.reset', () => {
    describe('success', () => {
      it('.reset after .vote', async () => {
        const { oal, voter, votingEscrow, deployer, mockLTokenAddresses } =
          await setup()
        const AMOUNT = '100'

        // Prerequisites
        const maxVoteDuration = (await voter.MAX_VOTE_DURATION()).toNumber()
        const maxTermCount = Math.floor(maxVoteDuration / TERM)
        const currentTermTs = Number(
          await voter.connect(ethers.provider).currentTermTimestamp()
        )
        ethers.provider.send('evm_mine', [currentTermTs + TERM - 1 * HOUR]) // proceed time to just before changing term
        let tx: ContractTransaction
        tx = await oal
          .connect(deployer)
          .approve(votingEscrow.address, parseEther(AMOUNT))
        await tx.wait()
        tx = await votingEscrow
          .connect(deployer)
          .createLock(parseEther(AMOUNT), 2 * YEAR)
        await tx.wait()
        const lockerId = await votingEscrow
          .connect(ethers.provider)
          .ownerToId(deployer.address)
        expect(lockerId.toString()).not.to.eq('0')

        // Execute
        const weights = mockLTokenAddresses.map((_, i) => (i == 0 ? 1 : 0))
        tx = await voter.connect(deployer).vote(weights)
        await tx.wait()
        const [ltoken] = mockLTokenAddresses

        //// Before .reset (after .vote)
        const weight = await voter.weights(lockerId, ltoken)
        expect(weight.toNumber()).to.eq(1)
        for await (const v of [
          { termCount: 0, isZero: true },
          { termCount: 1, isZero: false }, // at the start
          { termCount: maxTermCount + 1, isZero: false }, // at the end
          { termCount: maxTermCount + 2, isZero: true },
        ]) {
          const term = currentTermTs + v.termCount * TERM
          const [votes, votedTotalVotingWeights, poolWeights, totalWeight] =
            await Promise.all([
              voter.votes(lockerId, ltoken, term).then((v) => formatEther(v)),
              voter
                .votedTotalVotingWeights(lockerId, term)
                .then((v) => formatEther(v)),
              voter.poolWeights(ltoken, term).then((v) => formatEther(v)),
              voter.totalWeight(term).then((v) => formatEther(v)),
            ])
          if (v.isZero) {
            expect(votes).to.eq('0.0')
            expect(votedTotalVotingWeights).to.eq('0.0')
            expect(poolWeights).to.eq('0.0')
            expect(totalWeight).to.eq('0.0')
          } else {
            expect(Number(votes)).to.gt(0)
            expect(votedTotalVotingWeights).to.eq(votes)
            expect(poolWeights).to.eq(votes)
            expect(totalWeight).to.eq(votes)
          }
        }

        //// Execute .reset
        tx = await voter.connect(deployer).reset()
        await tx.wait()

        //// After .reset
        const _weight = await voter.weights(lockerId, ltoken)
        expect(_weight.toNumber()).to.eq(0)
        for await (const termCount of [
          1, // at the start
          maxTermCount + 1, // at the end
        ]) {
          const term = currentTermTs + termCount * TERM
          const [votes, votedTotalVotingWeights, poolWeights, totalWeight] =
            await Promise.all([
              voter.votes(lockerId, ltoken, term).then((v) => formatEther(v)),
              voter
                .votedTotalVotingWeights(lockerId, term)
                .then((v) => formatEther(v)),
              voter.poolWeights(ltoken, term).then((v) => formatEther(v)),
              voter.totalWeight(term).then((v) => formatEther(v)),
            ])
          expect(votes).to.eq('0.0')
          expect(votedTotalVotingWeights).to.eq('0.0')
          expect(poolWeights).to.eq('0.0')
          expect(totalWeight).to.eq('0.0')
        }
      })
    })
    describe('revert', () => {
      it('if no locker', async () => {
        const { voter, votingEscrow, deployer } = await setup()

        // Prerequisites
        const lockerId = await votingEscrow
          .connect(ethers.provider)
          .ownerToId(deployer.address)
        expect(lockerId.toString()).to.eq('0')

        // Execute
        await expect(voter.connect(deployer).reset()).to.be.revertedWith(
          'No lock associated with address'
        )
      })
    })
  })

  describe('.poke', () => {
    describe('success', () => {
      it('.poke after .vote', async () => {
        const { oal, voter, votingEscrow, deployer, mockLTokenAddresses } =
          await setup()
        const AMOUNT = '100'

        // Prerequisites
        const maxVoteDuration = (await voter.MAX_VOTE_DURATION()).toNumber()
        const maxTermCount = Math.floor(maxVoteDuration / TERM)
        const currentTermTs = Number(
          await voter.connect(ethers.provider).currentTermTimestamp()
        )
        ethers.provider.send('evm_mine', [currentTermTs + TERM - 1 * HOUR]) // proceed time to just before changing term
        let tx: ContractTransaction
        tx = await oal
          .connect(deployer)
          .approve(votingEscrow.address, parseEther(AMOUNT))
        await tx.wait()
        tx = await votingEscrow
          .connect(deployer)
          .createLock(parseEther(AMOUNT), 2 * YEAR)
        await tx.wait()
        const lockerId = await votingEscrow
          .connect(ethers.provider)
          .ownerToId(deployer.address)
        expect(lockerId.toString()).not.to.eq('0')

        // Execute
        const weights = mockLTokenAddresses.map((_, i) => (i == 0 ? 1 : 0))
        tx = await voter.connect(deployer).vote(weights)
        await tx.wait()
        const [ltoken] = mockLTokenAddresses

        //// Before .poke (after .vote)
        const weightBeforePoke = await voter.weights(lockerId, ltoken)
        const beforePoke: {
          [key in number]: {
            votes: string
            votedTotalVotingWeights: string
            poolWeights: string
            totalWeight: string
          }
        } = {}
        for await (const v of [
          { termCount: 0, isZero: true },
          { termCount: 1, isZero: false }, // at the start
          { termCount: maxTermCount + 1, isZero: false }, // at the end
          { termCount: maxTermCount + 2, isZero: true },
        ]) {
          const term = currentTermTs + v.termCount * TERM
          const [votes, votedTotalVotingWeights, poolWeights, totalWeight] =
            await Promise.all([
              voter.votes(lockerId, ltoken, term).then((v) => formatEther(v)),
              voter
                .votedTotalVotingWeights(lockerId, term)
                .then((v) => formatEther(v)),
              voter.poolWeights(ltoken, term).then((v) => formatEther(v)),
              voter.totalWeight(term).then((v) => formatEther(v)),
            ])
          if (v.isZero) {
            expect(votes).to.eq('0.0')
            expect(votedTotalVotingWeights).to.eq('0.0')
            expect(poolWeights).to.eq('0.0')
            expect(totalWeight).to.eq('0.0')
          } else {
            expect(Number(votes)).to.gt(0)
            expect(votedTotalVotingWeights).to.eq(votes)
            expect(poolWeights).to.eq(votes)
            expect(totalWeight).to.eq(votes)

            // save for checking with after poke
            Object.assign(beforePoke, {
              [v.termCount]: {
                votes,
                votedTotalVotingWeights,
                poolWeights,
                totalWeight,
              },
            })
          }
        }

        //// Execute .poke
        tx = await voter.connect(deployer).poke()
        await tx.wait()

        //// After .poke
        const weightAfterWeight = await voter.weights(lockerId, ltoken)
        expect(weightAfterWeight).to.eq(weightBeforePoke)
        for await (const termCount of [
          1, // at the start
          maxTermCount + 1, // at the end
        ]) {
          const term = currentTermTs + termCount * TERM
          const [votes, votedTotalVotingWeights, poolWeights, totalWeight] =
            await Promise.all([
              voter.votes(lockerId, ltoken, term).then((v) => formatEther(v)),
              voter
                .votedTotalVotingWeights(lockerId, term)
                .then((v) => formatEther(v)),
              voter.poolWeights(ltoken, term).then((v) => formatEther(v)),
              voter.totalWeight(term).then((v) => formatEther(v)),
            ])
          const _expect = beforePoke[termCount]
          expect(votes).to.eq(_expect.votes)
          expect(votedTotalVotingWeights).to.eq(_expect.votedTotalVotingWeights)
          expect(poolWeights).to.eq(_expect.poolWeights)
          expect(totalWeight).to.eq(_expect.totalWeight)
        }
      })
    })
    describe('revert', () => {
      it('if no locker', async () => {
        const { voter, votingEscrow, deployer } = await setup()

        // Prerequisites
        const lockerId = await votingEscrow
          .connect(ethers.provider)
          .ownerToId(deployer.address)
        expect(lockerId.toString()).to.eq('0')

        // Execute
        await expect(voter.connect(deployer).poke()).to.be.revertedWith(
          'No lock associated with address'
        )
      })
    })
  })

  describe('.claimableFor', () => {
    it('success', async () => {
      const { oal, voter, votingEscrow, deployer, mockLTokenAddresses } =
        await setup()

      // Prerequisites
      let tx: ContractTransaction
      tx = await oal.connect(deployer).approve(votingEscrow.address, '1')
      await tx.wait()
      tx = await votingEscrow.connect(deployer).createLock('1', 2 * YEAR)
      await tx.wait()
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).not.to.eq('0')

      // Execute
      const amounts = await voter
        .connect(ethers.provider)
        .claimableFor(deployer.address)
      expect(amounts.length).to.eq(mockLTokenAddresses.length)
      for (const amount of amounts) expect(amount.toString()).eq('0')
    })

    it('revert if no locker', async () => {
      const { voter, votingEscrow, deployer } = await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      await expect(
        voter.connect(ethers.provider).claimableFor(deployer.address)
      ).to.be.revertedWith('No lock associated with address')
    })
  })

  describe('.claimable', () => {
    it('success', async () => {
      const { oal, voter, votingEscrow, deployer, mockLTokenAddresses } =
        await setup()

      // Prerequisites
      let tx: ContractTransaction
      tx = await oal.connect(deployer).approve(votingEscrow.address, '1')
      await tx.wait()
      tx = await votingEscrow.connect(deployer).createLock('1', 2 * YEAR)
      await tx.wait()
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).not.to.eq('0')

      // Execute
      const amounts = await voter.connect(deployer).claimable()
      expect(amounts.length).to.eq(mockLTokenAddresses.length)
      for (const amount of amounts) expect(amount.toString()).eq('0')
    })

    it('revert if no locker', async () => {
      const { voter, votingEscrow, deployer } = await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      await expect(voter.connect(deployer).claimable()).to.be.revertedWith(
        'No lock associated with address'
      )
    })
  })

  describe('.claim', () => {
    describe('success', async () => {
      it('increase ltoken balance after .claim', async () => {
        const {
          oal,
          voter,
          votingEscrow,
          deployer,
          users,
          mockLTokenAddresses,
        } = await setup()
        const { provider } = ethers
        const [user] = users
        const [ltoken] = mockLTokenAddresses
        const LOCK_DURATION = 2 * YEAR
        const AMOUNT = parseEther('1')
        let tx: ContractTransaction

        // Prerequisites
        //   Adjust current time to just before term period
        const _currentTermTimestamp = Number(
          await voter.connect(provider).currentTermTimestamp()
        )
        provider.send('evm_mine', [_currentTermTimestamp + WEEK - 3 * HOUR])
        //   Create lock & add voting bonus to Voter & vote
        tx = await oal.connect(deployer).transfer(user.address, AMOUNT)
        await tx.wait()
        tx = await oal.connect(user).approve(votingEscrow.address, AMOUNT)
        await tx.wait()
        tx = await votingEscrow.connect(user).createLock(AMOUNT, LOCK_DURATION)
        await tx.wait()
        const weights = mockLTokenAddresses.map((_, i) => (i == 0 ? 1 : 0))
        tx = await voter.connect(user).vote(weights)
        await tx.wait()
        //   Advance time to after the lock duration
        const __currentTermTimestamp = Number(
          await voter.connect(provider).currentTermTimestamp()
        )
        ethers.provider.send('evm_mine', [
          __currentTermTimestamp + LOCK_DURATION,
        ])
        //   Update contracts statuses
        tx = await MockLToken__factory.connect(ltoken, deployer).mint(
          voter.address,
          AMOUNT
        )
        await tx.wait()
        tx = await votingEscrow.connect(deployer).checkpoint()
        await tx.wait()
        tx = await voter.connect(deployer).checkpointToken()
        await tx.wait()

        // Execute
        const beforeBalance = await MockLToken__factory.connect(
          ltoken,
          provider
        ).balanceOf(user.address)
        expect(beforeBalance.isZero()).to.eq(true)

        tx = await voter.connect(user).claim()
        await tx.wait()
        const afterBalance = await MockLToken__factory.connect(
          ltoken,
          provider
        ).balanceOf(user.address)
        expect(afterBalance.gt(0)).to.eq(true)
        await expect(voter.connect(user).claim()).to.emit(voter, 'Claimed')
      })
      it('update lastClaimTime after .claim', async () => {
        const {
          oal,
          voter,
          votingEscrow,
          deployer,
          users,
          mockLTokenAddresses,
        } = await setup()
        const { provider } = ethers
        const [user] = users
        const LOCK_DURATION = 1 * YEAR
        const AMOUNT = parseEther('1')
        let tx: ContractTransaction

        // Prerequisites
        //   Adjust current time to just before term period
        const _currentTermTimestamp = Number(
          await voter.connect(provider).currentTermTimestamp()
        )
        provider.send('evm_mine', [_currentTermTimestamp + WEEK - 3 * HOUR])
        //   Create lock & add voting bonus to Voter & vote
        tx = await oal.connect(deployer).transfer(user.address, AMOUNT)
        await tx.wait()
        tx = await oal.connect(user).approve(votingEscrow.address, AMOUNT)
        await tx.wait()
        tx = await votingEscrow.connect(user).createLock(AMOUNT, LOCK_DURATION)
        await tx.wait()
        const weights = mockLTokenAddresses.map((_, i) => (i == 0 ? 1 : 0))
        tx = await voter.connect(user).vote(weights)
        await tx.wait()
        const __currentTermTimestamp = Number(
          await voter.connect(provider).currentTermTimestamp()
        )
        const lockerId = (await votingEscrow.ownerToId(user.address)).toString()

        const params = [
          { point: 1.0 * MONTH },
          { point: 2.5 * MONTH },
          { point: 4.0 * MONTH },
          { point: 5.5 * MONTH },
        ]
        for await (const p of params) {
          const _baseTerm = __currentTermTimestamp + p.point
          provider.send('evm_mine', [_baseTerm - 3 * HOUR])
          tx = await votingEscrow.connect(deployer).checkpoint()
          await tx.wait()
          tx = await voter.connect(deployer).checkpointToken()
          await tx.wait()

          tx = await voter.connect(user).claim()
          await tx.wait()

          const lastClaimTime = (await voter.lastClaimTime(lockerId)).toNumber()
          expect(lastClaimTime).to.eq(_baseTerm - TERM)
        }
      })
    })
    describe('scenario: about .claim', async () => {
      const _setup = async () => {
        const { oal, users, deployer, voter, votingEscrow } =
          await setupWithoutTokens()
        // exec .addToken
        const [tokenA, tokenB] = await Promise.all([
          new MockLToken__factory(deployer).deploy('ATOKEN', 'ATOKEN'),
          new MockLToken__factory(deployer).deploy('BTOKEN', 'BTOKEN'),
        ])
        await (await voter.addToken(tokenA.address)).wait()
        await (await voter.addToken(tokenB.address)).wait()

        // exec .createLock
        const [userA, userB] = users
        const AMOUNT = parseEther('100')
        const LOCK_DURATION = 2 * YEAR

        const startTerm = (await voter.START_TIME()).toNumber()
        //ethers.provider.send('evm_mine', [startTerm + TERM - DAY])

        let tx: ContractTransaction
        tx = await oal.connect(deployer).transfer(userA.address, AMOUNT)
        await tx.wait()
        tx = await oal.connect(userA).approve(votingEscrow.address, AMOUNT)
        await tx.wait()
        tx = await votingEscrow.connect(userA).createLock(AMOUNT, LOCK_DURATION)
        await tx.wait()
        tx = await oal.connect(deployer).transfer(userB.address, AMOUNT)
        await tx.wait()
        tx = await oal.connect(userB).approve(votingEscrow.address, AMOUNT)
        await tx.wait()
        tx = await votingEscrow.connect(userB).createLock(AMOUNT, LOCK_DURATION)
        await tx.wait()
        const lockerIdA = (
          await votingEscrow.ownerToId(userA.address)
        ).toNumber()
        const lockerIdB = (
          await votingEscrow.ownerToId(userB.address)
        ).toNumber()

        return {
          votingEscrow: votingEscrow.connect(deployer),
          voter: voter.connect(deployer),
          tokenA,
          tokenB,
          userA,
          userB,
          lockerIdA,
          lockerIdB,
          startTerm,
        }
      }
      describe('check claimable term', () => {
        it('no claimable when current lastCheckpoint is initialTerm', async () => {
          const { votingEscrow, voter, tokenA, userA, startTerm } =
            await _setup()
          const _voter = voter.connect(userA)

          // Utilities
          const getClaimableForToken = async () =>
            Number(formatEther((await _voter.claimable())[0]))
          const getLastTokenTime = async () =>
            Number(await _voter.lastCheckpoint())

          // Execute
          await (await _voter.connect(userA).vote([1, 0])).wait()

          await ethers.provider.send('evm_mine', [startTerm + 0.5 * TERM]) // in initial term
          await (await tokenA.mint(voter.address, parseEther('1'))).wait()
          await (await votingEscrow.checkpoint()).wait()
          await (await _voter.checkpointToken()).wait()
          expect(await getClaimableForToken()).to.eq(0)
          expect(await getLastTokenTime()).to.gt(startTerm)

          await ethers.provider.send('evm_mine', [startTerm + 1.0 * TERM]) // to next term of initial term
          await (await tokenA.mint(voter.address, parseEther('200'))).wait()
          await (await votingEscrow.checkpoint()).wait()
          await (await _voter.checkpointToken()).wait()
          expect(await getClaimableForToken()).to.eq(0)
          expect(await getLastTokenTime()).to.greaterThan(startTerm + TERM)
          expect(await getLastTokenTime()).to.lessThanOrEqual(
            startTerm + TERM + 10
          )

          await ethers.provider.send('evm_mine', [startTerm + 2.0 * TERM]) // to next term of 2nd term
          // before checkpoints
          expect(await getClaimableForToken()).to.eq(0)
          await (await votingEscrow.checkpoint()).wait()
          await (await _voter.checkpointToken()).wait()
          // after checkpoints
          expect(await getClaimableForToken()).to.gt(0)
          expect(await getClaimableForToken()).to.lessThanOrEqual(201)
          expect(await getLastTokenTime()).to.greaterThan(startTerm + 2 * TERM)
          expect(await getLastTokenTime()).to.lessThanOrEqual(
            startTerm + 2 * TERM + 10
          )
        })
        it('execute claim in each term', async () => {
          const { votingEscrow, voter, tokenA, userA, lockerIdA, startTerm } =
            await _setup()
          const _voter = voter.connect(userA)
          const initialLastTokenTime = (await voter.lastCheckpoint()).toNumber()

          // Utilities
          const getBalanceOf = async () =>
            Number(formatEther(await tokenA.balanceOf(userA.address)))
          const getLastClaimTime = async () =>
            Number(await _voter.lastClaimTime(lockerIdA))

          // Execute
          await (await _voter.connect(userA).vote([1, 0])).wait()

          await ethers.provider.send('evm_mine', [startTerm + 0.5 * TERM]) // in initial term
          await (await tokenA.mint(voter.address, parseEther('1'))).wait()
          await (await votingEscrow.checkpoint()).wait()
          await (await _voter.checkpointToken()).wait()

          await (await _voter.claim()).wait()
          expect(await getBalanceOf()).to.eq(0)
          expect(await getLastClaimTime()).to.gt(0)

          await ethers.provider.send('evm_mine', [startTerm + 1.0 * TERM]) // to next term of initial term
          await (await tokenA.mint(voter.address, parseEther('200'))).wait()
          await (await votingEscrow.checkpoint()).wait()
          await (await _voter.checkpointToken()).wait()

          await (await _voter.claim()).wait()
          expect(await getBalanceOf()).to.eq(0)
          expect(await getLastClaimTime()).to.gt(0)

          await ethers.provider.send('evm_mine', [startTerm + 2.0 * TERM]) // to next term of 2nd term

          const claimable = Number(formatEther((await _voter.claimable())[0]))
          expect(claimable).to.eq(0)
          await (await _voter.claim()).wait() // run ._checkpointToken at the same time
          expect(await getBalanceOf()).to.gt(0)
          expect(await getBalanceOf()).to.lessThanOrEqual(201)
        })
        it('cannot claim/claimable for current term > with .claim', async () => {
          const { votingEscrow, voter, tokenA, userA, startTerm } =
            await _setup()
          const _voter = voter.connect(userA)

          // Utilities
          const callCheckpoints = async () => {
            await (await votingEscrow.checkpoint()).wait()
            await (await _voter.checkpointToken()).wait()
          }
          const transferTokenAndCheckpoint = async (amount: number) => {
            if (amount > 0) {
              await (
                await tokenA.mint(voter.address, parseEther(amount.toString()))
              ).wait()
            }
            await callCheckpoints()
          }
          const getBalanceOf = async () =>
            Number(formatEther(await tokenA.balanceOf(userA.address)))
          const getClaimableForToken = async () =>
            Number(formatEther((await _voter.claimable())[0]))

          // Execute
          await ethers.provider.send('evm_mine', [
            startTerm + 0.0 * TERM + (TERM - 120),
          ])
          await (await _voter.connect(userA).vote([1, 0])).wait()

          //// initial term
          await ethers.provider.send('evm_mine', [
            startTerm + 0.0 * TERM + (TERM - 15),
          ])
          await transferTokenAndCheckpoint(100)
          await (await _voter.claim()).wait()
          expect(await getBalanceOf()).eq(0) // because of no distributes in initial term & cannot claim for current term

          // 1st term
          await ethers.provider.send('evm_mine', [startTerm + 1.0 * TERM])
          await callCheckpoints() // fix distributes in previous term
          await ethers.provider.send('evm_mine', [
            startTerm + 1.0 * TERM + (TERM - 15),
          ])
          await transferTokenAndCheckpoint(2_000)
          await (await _voter.claim()).wait()
          expect(await getBalanceOf()).eq(0) // because user cannot claim for current term

          // 2nd term
          await ethers.provider.send('evm_mine', [startTerm + 2.0 * TERM])
          await callCheckpoints() // fix distributes in previous term
          await ethers.provider.send('evm_mine', [
            startTerm + 2.0 * TERM + (TERM - 15),
          ])
          await transferTokenAndCheckpoint(30_000)
          // before .claim
          expect(await getClaimableForToken()).to.gte(2000)
          expect(await getClaimableForToken()).to.lessThanOrEqual(2100)
          await (await _voter.claim()).wait()
          // after .claim
          expect(await getBalanceOf()).to.gte(2000)
          expect(await getBalanceOf()).to.lessThanOrEqual(2100)
          expect(await getClaimableForToken()).eq(0)

          //// 3rd term
          await ethers.provider.send('evm_mine', [startTerm + 3.0 * TERM])
          await callCheckpoints() // fix distributes in previous term
          await ethers.provider.send('evm_mine', [
            startTerm + 3.0 * TERM + (TERM - 15),
          ])
          await transferTokenAndCheckpoint(400_000)
          expect(await getClaimableForToken()).to.greaterThan(29500)
          expect(await getClaimableForToken()).to.lessThanOrEqual(30000)
          await (await _voter.claim()).wait()
          // after .claim
          expect(await getBalanceOf()).to.greaterThan(31500)
          expect(await getBalanceOf()).to.lessThanOrEqual(32100)
          expect(await getClaimableForToken()).eq(0)

          //// 4th term
          await ethers.provider.send('evm_mine', [startTerm + 4.0 * TERM])
          await callCheckpoints() // fix distributes in previous term
          await ethers.provider.send('evm_mine', [
            startTerm + 4.0 * TERM + (TERM - 15),
          ])
          await transferTokenAndCheckpoint(5_000_000)
          // before .claim
          expect(await getClaimableForToken()).to.greaterThan(380000)
          expect(await getClaimableForToken()).to.lessThanOrEqual(400000)
          await (await _voter.claim()).wait()
          // after .claim
          expect(await getBalanceOf()).to.greaterThan(425000)
          expect(await getBalanceOf()).to.lessThanOrEqual(432100)
          expect(await getClaimableForToken()).eq(0)
        })
        // Only one of previous/next can be executed (Time manipulation conflicts)
        it.skip('cannot claim/claimable for current term > .claimable only', async () => {
          const { votingEscrow, voter, tokenA, userA, startTerm } =
            await _setup()
          const _voter = voter.connect(userA)

          // Utilities
          const callCheckpoints = async () => {
            await (await votingEscrow.checkpoint()).wait()
            await (await _voter.checkpointToken()).wait()
          }
          const transferTokenAndCheckpoint = async (amount: number) => {
            if (amount > 0) {
              await (
                await tokenA.mint(voter.address, parseEther(amount.toString()))
              ).wait()
            }
            await callCheckpoints()
          }
          const getClaimableForToken = async () =>
            Number(formatEther((await _voter.claimable())[0]))

          // Execute
          await ethers.provider.send('evm_mine', [
            startTerm + 0.0 * TERM + (TERM - 120),
          ])
          await (await _voter.connect(userA).vote([1, 0])).wait()

          //// initial term
          await ethers.provider.send('evm_mine', [
            startTerm + 0.0 * TERM + (TERM - 15),
          ])
          await transferTokenAndCheckpoint(100)
          expect(await getClaimableForToken()).eq(0) // because of no distributes in initial term & cannot claim for current term

          // 1st term
          await ethers.provider.send('evm_mine', [startTerm + 1.0 * TERM])
          await callCheckpoints() // fix distributes in previous term
          await ethers.provider.send('evm_mine', [
            startTerm + 1.0 * TERM + (TERM - 15),
          ])
          await transferTokenAndCheckpoint(2_000)
          expect(await getClaimableForToken()).eq(0) // because user cannot claim for current term

          // 2nd term
          await ethers.provider.send('evm_mine', [startTerm + 2.0 * TERM])
          await callCheckpoints() // fix distributes in previous term
          await ethers.provider.send('evm_mine', [
            startTerm + 2.0 * TERM + (TERM - 15),
          ])
          await transferTokenAndCheckpoint(30_000)
          expect(await getClaimableForToken()).gt(2000)
          expect(await getClaimableForToken()).lessThanOrEqual(2100)

          //// 3rd term
          await ethers.provider.send('evm_mine', [startTerm + 3.0 * TERM])
          await callCheckpoints() // fix distributes in previous term
          await ethers.provider.send('evm_mine', [
            startTerm + 3.0 * TERM + (TERM - 15),
          ])
          await transferTokenAndCheckpoint(400_000)
          expect(await getClaimableForToken()).gt(31500)
          expect(await getClaimableForToken()).lessThanOrEqual(32100)

          //// 4th term
          await ethers.provider.send('evm_mine', [startTerm + 4.0 * TERM])
          await callCheckpoints() // fix distributes in previous term
          await ethers.provider.send('evm_mine', [
            startTerm + 4.0 * TERM + (TERM - 15),
          ])
          await transferTokenAndCheckpoint(5_000_000)
          expect(await getClaimableForToken()).gt(425000)
          expect(await getClaimableForToken()).lessThanOrEqual(432100)
        })
      })
      it('cannot double claim', async () => {
        const { votingEscrow, voter, tokenA, userA, userB, startTerm } =
          await _setup()

        // Utilities
        const getClaimableForToken = async (user: SignerWithAddress) =>
          Number(formatEther((await voter.connect(user).claimable())[0]))
        const balanceOfForToken = async (user: SignerWithAddress) =>
          Number(formatEther(await tokenA.balanceOf(user.address)))
        const claim = async (user: SignerWithAddress) =>
          await (await voter.connect(user).claim()).wait()

        // Execute
        await (await voter.connect(userA).vote([1, 0])).wait()
        await (await voter.connect(userB).vote([1, 3])).wait()
        await (await tokenA.mint(voter.address, parseEther('100'))).wait()

        //// In term that votes are not reflected (next to initial term)
        await ethers.provider.send('evm_mine', [startTerm + 2 * TERM - 30])
        await (await votingEscrow.checkpoint()).wait()
        await (await voter.checkpointToken()).wait()
        // -> not exist claimable
        expect(await getClaimableForToken(userA)).to.eq(0)
        expect(await getClaimableForToken(userB)).to.eq(0)

        //// In term that votes are reflected (one after the next to initial term)
        await ethers.provider.send('evm_mine', [startTerm + 2 * TERM])
        await (await votingEscrow.checkpoint()).wait()
        await (await voter.checkpointToken()).wait()
        // -> exist claimable
        expect(await getClaimableForToken(userA)).to.greaterThan(78)
        expect(await getClaimableForToken(userA)).to.lessThanOrEqual(80)
        expect(await getClaimableForToken(userB)).to.greaterThan(19)
        expect(await getClaimableForToken(userB)).to.lessThanOrEqual(20)
        await claim(userA)
        await claim(userB)
        const balanceOfA = await balanceOfForToken(userA)
        const balanceOfB = await balanceOfForToken(userB)
        expect(balanceOfA).to.greaterThan(78)
        expect(balanceOfA).to.lessThanOrEqual(80)
        expect(balanceOfB).to.greaterThan(19)
        expect(balanceOfB).to.lessThanOrEqual(20)
        expect(await getClaimableForToken(userA)).to.eq(0)
        expect(await getClaimableForToken(userB)).to.eq(0)
        // -> cannot double claim
        await claim(userA)
        await claim(userB)
        expect(await balanceOfForToken(userA)).to.eq(balanceOfA)
        expect(await balanceOfForToken(userB)).to.eq(balanceOfB)
      })
    })
    it('revert if no locker', async () => {
      const { voter, votingEscrow, deployer } = await setup()

      // Prerequisites
      const lockerId = await votingEscrow
        .connect(ethers.provider)
        .ownerToId(deployer.address)
      expect(lockerId.toString()).to.eq('0')

      // Execute
      await expect(voter.connect(deployer).claim()).to.be.revertedWith(
        'No lock associated with address'
      )
    })
  })

  describe('Scenario: vote to pools', () => {
    const multiTransferOal = async ({
      users,
      length,
      amount,
      oal,
      holder,
    }: {
      users: SignerWithAddress[]
      length: number
      amount: BigNumber
      oal: Token
      holder: SignerWithAddress
    }) => {
      const _lay = oal.connect(holder)
      const fns = [...Array(length)].map((_, i) =>
        _lay.transfer(users[i].address, amount)
      )
      const txs = await Promise.all(fns)
      for await (const tx of txs) tx.wait()
    }

    const multiApproveToVe = async ({
      users,
      oal,
      votingEscrowAddress,
    }: {
      users: SignerWithAddress[]
      oal: Token
      votingEscrowAddress: string
    }) => {
      for await (const user of users) {
        const tx = await oal
          .connect(user)
          .approve(votingEscrowAddress, ethers.constants.MaxUint256)
        await tx.wait()
      }
    }

    // Setup until transfer oal, approve after deployments
    const _setup = async (numOfUsers: number, amount?: BigNumber) => {
      const {
        provider,
        oal,
        votingEscrow,
        voter,
        deployer,
        users,
        mockLTokenAddresses,
      } = await setup()

      const _users = users.splice(0, numOfUsers)
      await multiTransferOal({
        users: _users,
        length: _users.length,
        amount: amount ? amount : BigNumber.from('10000'),
        oal,
        holder: deployer,
      })
      await multiApproveToVe({
        users: _users,
        oal,
        votingEscrowAddress: votingEscrow.address,
      })
      return {
        provider,
        votingEscrow,
        voter,
        users: _users,
        mockLTokenAddresses,
      }
    }

    describe('.totalWeight, .votedTotalVotingWeights after vote', () => {
      describe('Check the presence of weight', () => {
        // use before because of performance
        let currentTermTimestamp: number
        let _voter: Voter
        let _lockerId: string
        let revote: () => Promise<void>
        const LOCK_DURATION = 2 * YEAR
        before(async () => {
          const AMOUNT = parseEther('1')
          const { provider, votingEscrow, voter, users, mockLTokenAddresses } =
            await _setup(1, AMOUNT)
          let tx: ContractTransaction
          const [user] = users

          // Adjust current time to just before term period
          const _currentTermTimestamp = Number(
            await voter.connect(provider).currentTermTimestamp()
          )
          ethers.provider.send('evm_mine', [
            _currentTermTimestamp + TERM - 3 * HOUR,
          ])

          // Prerequisites
          tx = await votingEscrow
            .connect(user)
            .createLock(AMOUNT, LOCK_DURATION)
          await tx.wait()
          _lockerId = (await votingEscrow.ownerToId(user.address)).toString()

          currentTermTimestamp = Number(
            await voter.connect(provider).currentTermTimestamp()
          )

          const weights = mockLTokenAddresses.map((_, i) => (i == 0 ? 1 : 0))
          tx = await voter.connect(user).vote(weights)
          await tx.wait()

          revote = async () => {
            const _tx = await voter.connect(user).vote(weights)
            await _tx.wait()
          }

          _voter = voter.connect(provider)
        })

        it('weight of N-1 term is zero', async () => {
          const term = currentTermTimestamp - TERM
          const totalWeight = await _voter.totalWeight(term)
          expect(Number(formatEther(totalWeight))).to.eq(0)
        })
        it('weight of N term is zero', async () => {
          const term = currentTermTimestamp
          const totalWeight = await _voter.totalWeight(term)
          expect(Number(formatEther(totalWeight))).to.eq(0)
        })
        it('weight of N+1 term is not zero', async () => {
          const term = currentTermTimestamp + TERM
          const totalWeight = await _voter.totalWeight(term)
          expect(Number(formatEther(totalWeight))).to.greaterThan(0.99) // because of decay depended on lock timing
          expect(Number(formatEther(totalWeight))).to.lessThanOrEqual(1)
        })
        it('weight of N+2 term is not zero', async () => {
          const term = currentTermTimestamp + 2 * TERM
          const totalWeight = await _voter.totalWeight(term)
          expect(Number(formatEther(totalWeight))).to.greaterThan(0.98) // because of decay depended on lock timing
          expect(Number(formatEther(totalWeight))).to.lessThan(1)
        })
        it('weight in passed 25% lockend is about 75%', async () => {
          const ratio = 0.25
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time

          await ethers.provider.send('evm_mine', [term - TERM]) // for maxVoteDuration
          await revote()

          const totalWeight = await _voter.totalWeight(term)
          expect(Number(formatEther(totalWeight))).to.greaterThan(0.74)
          expect(Number(formatEther(totalWeight))).to.lessThanOrEqual(0.75)
        })
        it('weight in passed 50% lockend is about 50%', async () => {
          const ratio = 0.5
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time

          ethers.provider.send('evm_mine', [term - TERM]) // for maxVoteDuration
          await revote()

          const totalWeight = await _voter.totalWeight(term)
          expect(Number(formatEther(totalWeight))).to.greaterThan(0.49)
          expect(Number(formatEther(totalWeight))).to.lessThanOrEqual(0.5)
        })
        it('weight in passed 75% lockend is about 25%', async () => {
          const ratio = 0.75
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time

          ethers.provider.send('evm_mine', [term - TERM]) // for maxVoteDuration
          await revote()

          const totalWeight = await _voter.totalWeight(term)
          expect(Number(formatEther(totalWeight))).to.greaterThan(0.24)
          expect(Number(formatEther(totalWeight))).to.lessThanOrEqual(0.25)
        })
        it('weight in passed (100% - 1 week) lockend is greater than zero', async () => {
          const ratio = 1.0
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM + // consider elapsed time
            -TERM // back to locked end

          ethers.provider.send('evm_mine', [term - TERM]) // for maxVoteDuration
          await revote()

          const totalWeight = await _voter.totalWeight(term)
          expect(Number(formatEther(totalWeight))).to.greaterThan(0)
          expect(Number(formatEther(totalWeight))).to.lessThan(0.02)
        })
        it('weight in passed 100% lockend is zero', async () => {
          const ratio = 1.0
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time
          const weights = await _voter.votedTotalVotingWeights(_lockerId, term)
          expect(Number(formatEther(weights))).to.eq(0)
        })
        it("user's weight of N-1 term is zero", async () => {
          const term = currentTermTimestamp - TERM
          const weights = await _voter.votedTotalVotingWeights(_lockerId, term)
          expect(Number(formatEther(weights))).to.eq(0)
        })
        it("user's weight of N term is zero", async () => {
          const term = currentTermTimestamp
          const weights = await _voter.votedTotalVotingWeights(_lockerId, term)
          expect(Number(formatEther(weights))).to.eq(0)
        })
        it("user's weight of N+1 term is not zero", async () => {
          const term = currentTermTimestamp + TERM
          const weights = await _voter.votedTotalVotingWeights(_lockerId, term)
          expect(Number(formatEther(weights))).to.greaterThan(0.99) // because of decay depended on lock timing
          expect(Number(formatEther(weights))).to.lessThanOrEqual(1)
        })
        it("user's weight of N+2 term is not zero", async () => {
          const term = currentTermTimestamp + 2 * TERM
          const weights = await _voter.votedTotalVotingWeights(_lockerId, term)
          expect(Number(formatEther(weights))).to.greaterThan(0.98) // because of decay depended on lock timing
          expect(Number(formatEther(weights))).to.lessThan(1)
        })
        it("user's in passed 25% lockend is about 75%", async () => {
          const ratio = 0.25
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time

          const weight = await _voter.votedTotalVotingWeights(_lockerId, term)
          expect(Number(formatEther(weight))).to.greaterThan(0.74)
          expect(Number(formatEther(weight))).to.lessThanOrEqual(0.75)
        })
        it("user's in passed 50% lockend is about 50%", async () => {
          const ratio = 0.5
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time

          const weight = await _voter.votedTotalVotingWeights(_lockerId, term)
          expect(Number(formatEther(weight))).to.greaterThan(0.49)
          expect(Number(formatEther(weight))).to.lessThanOrEqual(0.5)
        })
        it("user's in passed 75% lockend is about 25%", async () => {
          const ratio = 0.75
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time
          const weight = await _voter.votedTotalVotingWeights(_lockerId, term)
          expect(Number(formatEther(weight))).to.greaterThan(0.24)
          expect(Number(formatEther(weight))).to.lessThanOrEqual(0.25)
        })
        it("user's in passed (100% - 1 term) lockend is greater than zero", async () => {
          const ratio = 1.0
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM + // consider elapsed time
            -TERM // back to locked end
          const weight = await _voter.votedTotalVotingWeights(_lockerId, term)
          expect(Number(formatEther(weight))).to.greaterThan(0)
          expect(Number(formatEther(weight))).to.lessThan(0.02)
        })
        it("user's in passed 100% lockend is zero", async () => {
          const ratio = 1.0
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time
          const weight = await _voter.votedTotalVotingWeights(_lockerId, term)
          expect(Number(formatEther(weight))).to.eq(0)
        })
      })

      describe('Check weights by lock duration as parameter of .createLock', () => {
        const setupWithLockingAndVoting = async (lockDuration: number) => {
          const AMOUNT = parseEther('1')
          const { provider, votingEscrow, voter, users, mockLTokenAddresses } =
            await _setup(1, AMOUNT)
          let tx: ContractTransaction
          const [user] = users
          // Prerequisites
          const currentTermTimestamp = Number(
            await voter.connect(provider).currentTermTimestamp()
          )
          ethers.provider.send('evm_mine', [currentTermTimestamp + TERM])
          tx = await votingEscrow.connect(user).createLock(AMOUNT, lockDuration)
          await tx.wait()
          const weights = mockLTokenAddresses.map((_, i) => (i == 0 ? 1 : 0))
          tx = await voter.connect(user).vote(weights)
          await tx.wait()

          return {
            currentTermTimestamp: currentTermTimestamp + TERM,
            voter: voter.connect(provider),
          }
        }

        it('if duration is 100% (2 year), most recent weight is about 100%', async () => {
          const DURATION = 2 * YEAR
          const { currentTermTimestamp, voter } =
            await setupWithLockingAndVoting(DURATION)
          const totalWeight = await voter.totalWeight(
            currentTermTimestamp + TERM
          )
          expect(Number(formatEther(totalWeight))).to.greaterThan(0.98) // because of decay depended on lock timing
          expect(Number(formatEther(totalWeight))).to.lessThanOrEqual(1)
        })
        it('if duration is 75% (1.5 year), most recent weight is about 75%', async () => {
          const DURATION = 1.5 * YEAR
          const { currentTermTimestamp, voter } =
            await setupWithLockingAndVoting(DURATION)
          const totalWeight = await voter.totalWeight(
            currentTermTimestamp + TERM
          )
          expect(Number(formatEther(totalWeight))).to.greaterThan(0.73) // because of decay depended on lock timing
          expect(Number(formatEther(totalWeight))).to.lessThanOrEqual(0.75)
        })
        it('if duration is 50% (1 year), most recent weight is about 50%', async () => {
          const DURATION = 1 * YEAR
          const { currentTermTimestamp, voter } =
            await setupWithLockingAndVoting(DURATION)
          const totalWeight = await voter.totalWeight(
            currentTermTimestamp + TERM
          )
          expect(Number(formatEther(totalWeight))).to.greaterThan(0.48) // because of decay depended on lock timing
          expect(Number(formatEther(totalWeight))).to.lessThanOrEqual(0.5)
        })
        it('if duration is 25% (0.5 year), most recent weight is about 25%', async () => {
          const DURATION = 0.5 * YEAR
          const { currentTermTimestamp, voter } =
            await setupWithLockingAndVoting(DURATION)
          const totalWeight = await voter.totalWeight(
            currentTermTimestamp + TERM
          )
          expect(Number(formatEther(totalWeight))).to.greaterThan(0.23) // because of decay depended on lock timing
          expect(Number(formatEther(totalWeight))).to.lessThanOrEqual(0.25)
        })
        it('if duration is MINIMUM (2 term (current & next)), most recent weight is greater than zero', async () => {
          const DURATION = 2 * TERM
          const { currentTermTimestamp, voter } =
            await setupWithLockingAndVoting(DURATION)
          const totalWeight = await voter.totalWeight(
            currentTermTimestamp + TERM
          )
          expect(Number(formatEther(totalWeight))).to.greaterThan(0)
          // 2 year = 52 week * 2 = 104 week => 52 term -> 1/52 ≒ under 2%
          expect(Number(formatEther(totalWeight))).to.lessThanOrEqual(0.02)
        })
      })

      describe('Check in multi users case', () => {
        it('totalWeight is sum of .votedTotalVotingWeights of all users', async () => {
          const NUM_OF_USERS = 3
          const LOCK_DURATION = 2 * YEAR
          const AMOUNT = parseEther('100')
          const { provider, votingEscrow, voter, users } = await _setup(
            NUM_OF_USERS,
            AMOUNT
          )
          let tx: ContractTransaction
          const _users = users.splice(0, NUM_OF_USERS)
          const params = [
            { lockerId: 1, user: _users[0], weights: [1, 0, 0, 0, 0] },
            { lockerId: 2, user: _users[1], weights: [1, 0, 1, 0, 0] },
            { lockerId: 3, user: _users[2], weights: [1, 0, 1, 0, 2] },
          ]

          // Prerequisites
          for await (const p of params) {
            tx = await votingEscrow
              .connect(p.user)
              .createLock(AMOUNT, LOCK_DURATION)
            await tx.wait()
            tx = await voter.connect(p.user).vote(p.weights)
            await tx.wait()
          }

          // Confirm
          const _voter = await voter.connect(provider)
          const currentTermTimestamp = Number(
            await _voter.currentTermTimestamp()
          )
          const term = currentTermTimestamp + TERM
          for await (const p of params) {
            const weights = await _voter.votedTotalVotingWeights(
              p.lockerId,
              term
            )
            expect(Number(formatEther(weights))).to.greaterThan(98)
            expect(Number(formatEther(weights))).to.lessThan(100)
          }
          const totalWeights = await _voter.totalWeight(term)
          expect(Number(formatEther(totalWeights))).to.greaterThan(98 * 3)
          expect(Number(formatEther(totalWeights))).to.lessThan(100 * 3)
        })
      })
    })

    describe('.poolWeights, .votes after vote', () => {
      describe('Check weights according to the specified ratio', () => {
        const __setup = async (weights: BigNumberish[]) => {
          const AMOUNT = parseEther('100')
          const LOCK_DURATION = 2 * YEAR

          const { provider, votingEscrow, voter, users, mockLTokenAddresses } =
            await _setup(1, AMOUNT)
          let tx: ContractTransaction
          const [user] = users

          // Prerequisites
          tx = await votingEscrow
            .connect(user)
            .createLock(AMOUNT, LOCK_DURATION)
          await tx.wait()

          const currentTermTimestamp = Number(
            await voter.connect(provider).currentTermTimestamp()
          )
          tx = await voter.connect(user).vote(weights)
          await tx.wait()

          const term = currentTermTimestamp + TERM

          return { voter, term, mockLTokenAddresses }
        }

        it('four pools is 25%, the rest are 0%', async () => {
          const weights = [1, 1, 0, 1, 1]
          const { voter, term, mockLTokenAddresses } = await __setup(weights)

          const poolWeights = []
          for await (const addr of mockLTokenAddresses) {
            poolWeights.push(await voter.poolWeights(addr, term))
          }

          expect(Number(formatEther(poolWeights[0]))).to.greaterThan(24)
          expect(Number(formatEther(poolWeights[0]))).to.lessThanOrEqual(25)
          expect(Number(formatEther(poolWeights[1]))).to.greaterThan(24)
          expect(Number(formatEther(poolWeights[1]))).to.lessThanOrEqual(25)
          expect(Number(formatEther(poolWeights[2]))).to.eq(0)
          expect(Number(formatEther(poolWeights[3]))).to.greaterThan(24)
          expect(Number(formatEther(poolWeights[3]))).to.lessThanOrEqual(25)
          expect(Number(formatEther(poolWeights[4]))).to.greaterThan(24)
          expect(Number(formatEther(poolWeights[4]))).to.lessThanOrEqual(25)
        })

        it('10% 15% 20% 25% 30%', async () => {
          const weights = [2, 3, 4, 5, 6]
          const { voter, term, mockLTokenAddresses } = await __setup(weights)

          const poolWeights = []
          for await (const addr of mockLTokenAddresses) {
            poolWeights.push(await voter.poolWeights(addr, term))
          }

          expect(Number(formatEther(poolWeights[0]))).to.greaterThan(9)
          expect(Number(formatEther(poolWeights[0]))).to.lessThanOrEqual(10)
          expect(Number(formatEther(poolWeights[1]))).to.greaterThan(14)
          expect(Number(formatEther(poolWeights[1]))).to.lessThanOrEqual(15)
          expect(Number(formatEther(poolWeights[2]))).to.greaterThan(19)
          expect(Number(formatEther(poolWeights[2]))).to.lessThanOrEqual(20)
          expect(Number(formatEther(poolWeights[3]))).to.greaterThan(24)
          expect(Number(formatEther(poolWeights[3]))).to.lessThanOrEqual(25)
          expect(Number(formatEther(poolWeights[4]))).to.greaterThan(29)
          expect(Number(formatEther(poolWeights[4]))).to.lessThanOrEqual(30)
        })
      })

      describe('Check weights when', () => {
        // use before because of performance
        let currentTermTimestamp: number
        let _voter: Voter
        let _lockerId: string
        let _poolAddresses: string[]
        let revote: () => Promise<void>
        const LOCK_DURATION = 2 * YEAR
        before(async () => {
          const AMOUNT = parseEther('100')
          const { provider, votingEscrow, voter, users, mockLTokenAddresses } =
            await _setup(1, AMOUNT)
          let tx: ContractTransaction
          const [user] = users

          // Adjust current time to just before term period
          const _currentTermTimestamp = Number(
            await voter.connect(provider).currentTermTimestamp()
          )
          ethers.provider.send('evm_mine', [
            _currentTermTimestamp + TERM - 3 * HOUR,
          ])

          // Prerequisites
          tx = await votingEscrow
            .connect(user)
            .createLock(AMOUNT, LOCK_DURATION)
          await tx.wait()
          _lockerId = (await votingEscrow.ownerToId(user.address)).toString()

          currentTermTimestamp = Number(
            await voter.connect(provider).currentTermTimestamp()
          )

          const weights = [1, 1, 0, 0, 0]
          tx = await voter.connect(user).vote(weights)
          await tx.wait()

          revote = async () => {
            const _tx = await voter.connect(user).vote(weights)
            await _tx.wait()
          }

          _voter = voter.connect(provider)
          _poolAddresses = mockLTokenAddresses
        })

        it('pool weight of N-1 term is zero', async () => {
          const term = currentTermTimestamp - TERM
          const poolWeights = []
          for await (const addr of _poolAddresses) {
            poolWeights.push(await _voter.poolWeights(addr, term))
          }
          for await (const weight of poolWeights) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it('pool weight of N term is zero', async () => {
          const term = currentTermTimestamp
          const poolWeights = []
          for await (const addr of _poolAddresses) {
            poolWeights.push(await _voter.poolWeights(addr, term))
          }
          for await (const weight of poolWeights) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it('pool weight of N+1 term is not zero', async () => {
          const term = currentTermTimestamp + TERM
          const poolWeights = []
          for await (const addr of _poolAddresses) {
            poolWeights.push(await _voter.poolWeights(addr, term))
          }
          const [one, two, ...rests] = poolWeights
          expect(Number(formatEther(one))).to.greaterThan(49)
          expect(Number(formatEther(one))).to.lessThanOrEqual(50)
          expect(Number(formatEther(two))).to.greaterThan(49)
          expect(Number(formatEther(two))).to.lessThanOrEqual(50)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it('pool weight of N+2 term is not zero', async () => {
          const term = currentTermTimestamp + 2 * TERM
          const poolWeights = []
          for await (const addr of _poolAddresses) {
            poolWeights.push(await _voter.poolWeights(addr, term))
          }
          const [one, two, ...rests] = poolWeights
          expect(Number(formatEther(one))).to.greaterThan(49)
          expect(Number(formatEther(one))).to.lessThanOrEqual(50)
          expect(Number(formatEther(two))).to.greaterThan(49)
          expect(Number(formatEther(two))).to.lessThanOrEqual(50)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it('pool weight in passed 25% lockend is about 75%', async () => {
          const ratio = 0.25
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time

          ethers.provider.send('evm_mine', [term - TERM]) // for maxVoteDuration
          await revote()

          const poolWeights = []
          for await (const addr of _poolAddresses) {
            poolWeights.push(await _voter.poolWeights(addr, term))
          }
          const [one, two, ...rests] = poolWeights
          expect(Number(formatEther(one))).to.greaterThan(37.4)
          expect(Number(formatEther(one))).to.lessThanOrEqual(37.5)
          expect(Number(formatEther(two))).to.greaterThan(37.4)
          expect(Number(formatEther(two))).to.lessThanOrEqual(37.5)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it('pool weight in passed 50% lockend is about 50%', async () => {
          const ratio = 0.5
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time

          ethers.provider.send('evm_mine', [term - TERM]) // for maxVoteDuration
          await revote()

          const poolWeights = []
          for await (const addr of _poolAddresses) {
            poolWeights.push(await _voter.poolWeights(addr, term))
          }
          const [one, two, ...rests] = poolWeights
          expect(Number(formatEther(one))).to.greaterThan(24.9)
          expect(Number(formatEther(one))).to.lessThanOrEqual(25)
          expect(Number(formatEther(two))).to.greaterThan(24.9)
          expect(Number(formatEther(two))).to.lessThanOrEqual(25)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it('pool weight in passed 75% lockend is about 25%', async () => {
          const ratio = 0.75
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time

          ethers.provider.send('evm_mine', [term - TERM]) // for maxVoteDuration
          await revote()

          const poolWeights = []
          for await (const addr of _poolAddresses) {
            poolWeights.push(await _voter.poolWeights(addr, term))
          }
          const [one, two, ...rests] = poolWeights
          expect(Number(formatEther(one))).to.greaterThan(12.4)
          expect(Number(formatEther(one))).to.lessThanOrEqual(12.5)
          expect(Number(formatEther(two))).to.greaterThan(12.4)
          expect(Number(formatEther(two))).to.lessThanOrEqual(12.5)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it('pool weight in passed (100% - 1 term) lockend is greater than zero', async () => {
          const ratio = 1.0
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM + // consider elapsed time
            -TERM // back to locked end

          ethers.provider.send('evm_mine', [term - TERM]) // for maxVoteDuration
          await revote()

          const poolWeights = []
          for await (const addr of _poolAddresses) {
            poolWeights.push(await _voter.poolWeights(addr, term))
          }
          const [one, two, ...rests] = poolWeights
          expect(Number(formatEther(one))).to.greaterThan(0)
          expect(Number(formatEther(one))).to.lessThanOrEqual(1)
          expect(Number(formatEther(two))).to.greaterThan(0)
          expect(Number(formatEther(two))).to.lessThanOrEqual(1)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it('pool weight in passed 100% lockend is zero', async () => {
          const ratio = 1.0
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time
          const poolWeights = []
          for await (const addr of _poolAddresses) {
            poolWeights.push(await _voter.poolWeights(addr, term))
          }
          for await (const weight of poolWeights) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it("user's pool weight of N-1 term is zero", async () => {
          const term = currentTermTimestamp - TERM
          const votes = []
          for await (const addr of _poolAddresses) {
            votes.push(await _voter.votes(_lockerId, addr, term))
          }
          for await (const weight of votes) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it("user's pool weight of N term is zero", async () => {
          const term = currentTermTimestamp
          const votes = []
          for await (const addr of _poolAddresses) {
            votes.push(await _voter.votes(_lockerId, addr, term))
          }
          for await (const weight of votes) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it("user's pool weight of N+1 term is not zero", async () => {
          const term = currentTermTimestamp + TERM
          const votes = []
          for await (const addr of _poolAddresses) {
            votes.push(await _voter.votes(_lockerId, addr, term))
          }
          const [one, two, ...rests] = votes
          expect(Number(formatEther(one))).to.greaterThan(49)
          expect(Number(formatEther(one))).to.lessThanOrEqual(50)
          expect(Number(formatEther(two))).to.greaterThan(49)
          expect(Number(formatEther(two))).to.lessThanOrEqual(50)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it("user's pool weight of N+2 term is not zero", async () => {
          const term = currentTermTimestamp + 2 * TERM
          const votes = []
          for await (const addr of _poolAddresses) {
            votes.push(await _voter.votes(_lockerId, addr, term))
          }
          const [one, two, ...rests] = votes
          expect(Number(formatEther(one))).to.greaterThan(49)
          expect(Number(formatEther(one))).to.lessThanOrEqual(50)
          expect(Number(formatEther(two))).to.greaterThan(49)
          expect(Number(formatEther(two))).to.lessThanOrEqual(50)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it("user's pool weight in passed 25% lockend is about 75%", async () => {
          const ratio = 0.25
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time
          const votes = []
          for await (const addr of _poolAddresses) {
            votes.push(await _voter.votes(_lockerId, addr, term))
          }
          const [one, two, ...rests] = votes
          expect(Number(formatEther(one))).to.greaterThan(37.4)
          expect(Number(formatEther(one))).to.lessThanOrEqual(37.5)
          expect(Number(formatEther(two))).to.greaterThan(37.4)
          expect(Number(formatEther(two))).to.lessThanOrEqual(37.5)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it("user's pool weight in passed 50% lockend is about 50%", async () => {
          const ratio = 0.5
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time
          const votes = []
          for await (const addr of _poolAddresses) {
            votes.push(await _voter.votes(_lockerId, addr, term))
          }
          const [one, two, ...rests] = votes
          expect(Number(formatEther(one))).to.greaterThan(24.9)
          expect(Number(formatEther(one))).to.lessThanOrEqual(25)
          expect(Number(formatEther(two))).to.greaterThan(24.9)
          expect(Number(formatEther(two))).to.lessThanOrEqual(25)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it("user's pool weight in passed 75% lockend is about 25%", async () => {
          const ratio = 0.75
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time
          const votes = []
          for await (const addr of _poolAddresses) {
            votes.push(await _voter.votes(_lockerId, addr, term))
          }
          const [one, two, ...rests] = votes
          expect(Number(formatEther(one))).to.greaterThan(12.4)
          expect(Number(formatEther(one))).to.lessThanOrEqual(12.5)
          expect(Number(formatEther(two))).to.greaterThan(12.4)
          expect(Number(formatEther(two))).to.lessThanOrEqual(12.5)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it("user's pool weight in passed (100% - 1 term) lockend is greater than zero", async () => {
          const ratio = 1.0
          const term =
            currentTermTimestamp +
            TERM + // start is next term
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM + // consider elapsed time
            -TERM // back to locked end
          const votes = []
          for await (const addr of _poolAddresses) {
            votes.push(await _voter.votes(_lockerId, addr, term))
          }
          const [one, two, ...rests] = votes
          expect(Number(formatEther(one))).to.greaterThan(0)
          expect(Number(formatEther(one))).to.lessThanOrEqual(1)
          expect(Number(formatEther(two))).to.greaterThan(0)
          expect(Number(formatEther(two))).to.lessThanOrEqual(1)
          for await (const weight of rests) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
        it("user's pool weight in passed 100% lockend is zero", async () => {
          const ratio = 1.0
          const term =
            currentTermTimestamp +
            TERM + // start is next week
            Math.floor(Math.floor(LOCK_DURATION * ratio) / TERM) * TERM // consider elapsed time
          const votes = []
          for await (const addr of _poolAddresses) {
            votes.push(await _voter.votes(_lockerId, addr, term))
          }
          for await (const weight of votes) {
            expect(Number(formatEther(weight))).to.eq(0)
          }
        })
      })

      describe('Check in multi users case', () => {
        it('poolWeights for each pool is sum of .votes of all users', async () => {
          const NUM_OF_USERS = 3
          const LOCK_DURATION = 2 * YEAR
          const AMOUNT = parseEther('100')
          const { provider, votingEscrow, voter, users, mockLTokenAddresses } =
            await _setup(NUM_OF_USERS, AMOUNT)
          let tx: ContractTransaction
          const _users = users.splice(0, NUM_OF_USERS)
          const params = [
            { lockerId: 1, user: _users[0], weights: [1, 0, 0, 0, 0] },
            { lockerId: 2, user: _users[1], weights: [1, 0, 1, 0, 0] },
            { lockerId: 3, user: _users[2], weights: [1, 0, 1, 0, 2] },
          ]
          // Adjust current time to just before term period
          const _currentTermTimestamp = Number(
            await voter.connect(provider).currentTermTimestamp()
          )
          ethers.provider.send('evm_mine', [
            _currentTermTimestamp + TERM - 3 * HOUR,
          ])

          // Prerequisites
          for await (const p of params) {
            tx = await votingEscrow
              .connect(p.user)
              .createLock(AMOUNT, LOCK_DURATION)
            await tx.wait()
            tx = await voter.connect(p.user).vote(p.weights)
            await tx.wait()
          }
          // Confirm
          const _voter = await voter.connect(provider)
          const currentTermTimestamp = Number(
            await _voter.currentTermTimestamp()
          )
          const term = currentTermTimestamp + TERM
          // each user
          // - user 1
          const votes1 = []
          for await (const addr of mockLTokenAddresses) {
            votes1.push(await _voter.votes(params[0].lockerId, addr, term))
          }
          expect(Number(formatEther(votes1[0]))).to.greaterThan(99)
          expect(Number(formatEther(votes1[0]))).to.lessThanOrEqual(100)
          expect(Number(formatEther(votes1[1]))).to.eq(0)
          expect(Number(formatEther(votes1[2]))).to.eq(0)
          expect(Number(formatEther(votes1[3]))).to.eq(0)
          expect(Number(formatEther(votes1[4]))).to.eq(0)
          // - user 2
          const votes2 = []
          for await (const addr of mockLTokenAddresses) {
            votes2.push(await _voter.votes(params[1].lockerId, addr, term))
          }
          expect(Number(formatEther(votes2[0]))).to.greaterThan(49)
          expect(Number(formatEther(votes2[0]))).to.lessThanOrEqual(50)
          expect(Number(formatEther(votes2[1]))).to.eq(0)
          expect(Number(formatEther(votes2[2]))).to.greaterThan(49)
          expect(Number(formatEther(votes2[2]))).to.lessThanOrEqual(50)
          expect(Number(formatEther(votes2[3]))).to.eq(0)
          expect(Number(formatEther(votes2[4]))).to.eq(0)
          // - user 3
          const votes3 = []
          for await (const addr of mockLTokenAddresses) {
            votes3.push(await _voter.votes(params[2].lockerId, addr, term))
          }
          expect(Number(formatEther(votes3[0]))).to.greaterThan(24)
          expect(Number(formatEther(votes3[0]))).to.lessThanOrEqual(25)
          expect(Number(formatEther(votes3[1]))).to.eq(0)
          expect(Number(formatEther(votes3[2]))).to.greaterThan(24)
          expect(Number(formatEther(votes3[2]))).to.lessThanOrEqual(25)
          expect(Number(formatEther(votes3[3]))).to.eq(0)
          expect(Number(formatEther(votes3[4]))).to.greaterThan(49)
          expect(Number(formatEther(votes3[4]))).to.lessThanOrEqual(50)
          // entire contract
          const poolWeights = []
          for await (const addr of mockLTokenAddresses) {
            poolWeights.push(await _voter.poolWeights(addr, term))
          }
          expect(Number(formatEther(poolWeights[0]))).to.greaterThan(174)
          expect(Number(formatEther(poolWeights[0]))).to.lessThanOrEqual(175)
          expect(Number(formatEther(poolWeights[1]))).to.eq(0)
          expect(Number(formatEther(poolWeights[2]))).to.greaterThan(74)
          expect(Number(formatEther(poolWeights[2]))).to.lessThanOrEqual(75)
          expect(Number(formatEther(poolWeights[3]))).to.eq(0)
          expect(Number(formatEther(poolWeights[4]))).to.greaterThan(49)
          expect(Number(formatEther(poolWeights[4]))).to.lessThanOrEqual(50)
        })
      })
    })
  })
})
