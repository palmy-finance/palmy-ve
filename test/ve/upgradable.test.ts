import { expect } from 'chai'
import { parseEther } from 'ethers/lib/utils'
import { ethers, upgrades } from 'hardhat'
import {
  MockLToken__factory,
  MockLendingPool__factory,
  TestVoterRevX,
  TestVoterRevX__factory,
  TestVotingEscrowRevX,
  TestVotingEscrowRevX__factory,
  Token__factory,
  Voter,
  Voter__factory,
  VotingEscrow,
  VotingEscrow__factory,
} from '../../types'
import { DAY, TERM } from './utils'

// Constants
const TOKEN_PARAMETERS: { token: string }[] = [
  // { token: 'lDAI' },
  // { token: 'lWASTR' },
  // { token: 'lWSDN' },
  // { token: 'lWBTC' },
  { token: 'lWETH' },
  { token: 'lUSDT' },
  { token: 'lUSDC' },
  // { token: 'lOAL' },
  // { token: 'lBUSD' },
  // { token: 'lDAI' },
  // { token: 'lMATIC' },
  // { token: 'lBNB' },
  // { token: 'lDOT' },
]

// Prepare
const setupMockLTokens = async (
  factory: MockLToken__factory
): Promise<string[]> => {
  const tokens = await Promise.all(
    TOKEN_PARAMETERS.map((p) => factory.deploy(p.token, p.token))
  )
  for await (const token of tokens) {
    await token.deployTransaction.wait()
  }
  return tokens.map((t) => t.address)
}

const setup = async () => {
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
  const tokenAddresses = await setupMockLTokens(
    new MockLToken__factory(deployer)
  )
  for await (const token of tokenAddresses) {
    const tx = await voter.addToken(token)
    await tx.wait()
  }
  const tx = await votingEscrow.setVoter(voter.address)
  await tx.wait()

  return {
    provider: ethers.provider,
    oal,
    votingEscrow,
    voter,
    deployer,
    users: rest,
    mockLTokenAddresses: tokenAddresses,
    lendingPool,
  }
}

describe('upgradable', () => {
  describe('Voter', () => {
    it('success', async () => {
      const { deployer, voter, votingEscrow } = await setup()
      const [ve, term, maxVoteDuration] = await Promise.all([
        voter._ve(),
        voter._term().then((v) => v.toNumber()),
        voter.maxVoteDuration().then((v) => v.toNumber()),
      ])
      expect(ve).to.eq(votingEscrow.address)
      expect(term).to.eq(TERM)
      expect(maxVoteDuration).to.eq(6 * 30 * DAY)

      // upgrade
      const upgraded = await upgrades.upgradeProxy(
        voter,
        new TestVoterRevX__factory(deployer),
        { call: { fn: 'initializeV2' } }
      )
      const upgradedVoter = upgraded as TestVoterRevX
      const [_ve, _term, _maxVoteDuration] = await Promise.all([
        upgradedVoter._ve(),
        upgradedVoter._term().then((v) => v.toNumber()),
        upgradedVoter.maxVoteDuration().then((v) => v.toNumber()),
      ])
      expect(_ve).to.eq(ve)
      expect(_term).to.eq(term)
      expect(_maxVoteDuration).not.to.eq(maxVoteDuration)
      expect(_maxVoteDuration).to.eq(12 * 30 * DAY)

      // call added function
      expect(await upgradedVoter.contractVersion()).to.eq(2)
    })
  })
  describe('VotingEscrow', () => {
    it('success', async () => {
      const { deployer, votingEscrow } = await setup()
      const [name, symbol, decimals, version] = await Promise.all([
        votingEscrow.name(),
        votingEscrow.symbol(),
        votingEscrow.decimals(),
        votingEscrow.version(),
      ])
      expect(name).to.eq('Vote-escrowed OAL')
      expect(symbol).to.eq('veOAL')
      expect(decimals).to.eq(18)
      expect(version).to.eq('1.0.0')

      // upgrade
      const upgraded = await upgrades.upgradeProxy(
        votingEscrow,
        new TestVotingEscrowRevX__factory(deployer),
        { call: { fn: 'initializeV2' } }
      )
      const upgradedVotingEscrow = upgraded as TestVotingEscrowRevX
      const [_name, _symbol, _decimals, _version] = await Promise.all([
        upgradedVotingEscrow.name(),
        upgradedVotingEscrow.symbol(),
        upgradedVotingEscrow.decimals(),
        upgradedVotingEscrow.version(),
      ])
      expect(_name).to.eq(name)
      expect(_symbol).to.eq(_symbol)
      expect(_decimals).to.eq(_decimals)
      expect(_version).not.to.eq(version)
      expect(_version).to.eq('X.0.0')

      // call added function
      expect(await upgradedVotingEscrow.contractVersion()).to.eq(2)
    })
  })
})
