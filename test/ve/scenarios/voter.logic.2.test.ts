import { JsonRpcProvider } from '@ethersproject/providers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { BigNumber, ContractTransaction } from 'ethers'
import { formatEther, parseEther } from 'ethers/lib/utils'
import { ethers, upgrades } from 'hardhat'
import {
  MockLToken__factory,
  MockLendingPool__factory,
  Token,
  Token__factory,
  Voter,
  Voter__factory,
  VotingEscrow,
  VotingEscrow__factory,
} from '../../../types'

// Constants
const HOUR = 60 * 60 // in minute
const DAY = HOUR * 24
const WEEK = 7 * DAY
// const MONTH = 4 * WEEK
// const YEAR = 12 * MONTH
const YEAR = 365 * 86400
const TERM = 2 * WEEK

const TOKEN_PARAMETERS: { token: string }[] = [
  { token: 'lDAI' },
  { token: 'lWASTR' },
  { token: 'lWSDN' },
  { token: 'lWBTC' },
  { token: 'lWETH' },
  // { token: 'lUSDT' },
  // { token: 'lUSDC' },
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
  const _oal = oal.connect(holder)
  const fns = [...Array(length)].map((_, i) =>
    _oal.transfer(users[i].address, amount)
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

const setup = async () => {
  const [deployer, ...rest] = await ethers.getSigners()
  const oal = await new Token__factory(deployer).deploy(
    'OAL',
    'OAL',
    parseEther('100000'),
    await deployer.getAddress()
  )
  await oal.deployTransaction.wait()
  const votingEscrow = (await upgrades.deployProxy(
    new VotingEscrow__factory(deployer),
    [oal.address]
  )) as VotingEscrow
  await votingEscrow.deployTransaction.wait()
  const lendingPool = await new MockLendingPool__factory(deployer).deploy()
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

// Utils
const _current = async (provider: JsonRpcProvider) => {
  const currentBlock = await provider.getBlock(await provider.getBlockNumber())
  const currentTerm = Math.floor(currentBlock.timestamp / TERM) * TERM
  return {
    ts: currentBlock.timestamp,
    term: currentTerm,
  }
}

describe('Voter.sol: Confirming logic to check voted weights', () => {
  it('check term', async () => {
    const currentBlock = await ethers.provider.getBlock(
      await ethers.provider.getBlockNumber()
    )
    const currentTerm = Math.floor(currentBlock.timestamp / TERM) * TERM
    console.log(`now: ${new Date(currentBlock.timestamp * 1000).toISOString()}`)
    console.log({
      previous: new Date((currentTerm - TERM) * 1000).toISOString(),
      current: new Date(currentTerm * 1000).toISOString(),
      next: new Date((currentTerm + TERM) * 1000).toISOString(),
    })
  })
  describe('scenario: check weights', () => {
    const NUM_OF_USERS = 3
    let _voter: Voter
    let _users: SignerWithAddress[]
    let _tokens: string[]
    beforeEach(async () => {
      const { term } = await _current(ethers.provider)
      ethers.provider.send('evm_mine', [term + TERM + 1 * HOUR]) // proceeded time to immediately after the start
      const { oal, votingEscrow, voter, deployer, users, mockLTokenAddresses } =
        await setup()
      _users = users.splice(0, NUM_OF_USERS)

      const [uA, uB, uC] = _users
      await multiTransferOal({
        users: _users,
        length: NUM_OF_USERS,
        amount: parseEther('100'),
        oal,
        holder: deployer,
      })
      await multiApproveToVe({
        users: _users,
        oal,
        votingEscrowAddress: votingEscrow.address,
      })
      const tx1 = await votingEscrow
        .connect(uA)
        .createLock(parseEther('100'), 2 * YEAR)
      const tx2 = await votingEscrow
        .connect(uB)
        .createLock(parseEther('100'), 2 * YEAR)
      const tx3 = await votingEscrow
        .connect(uC)
        .createLock(parseEther('100'), 2 * YEAR)
      await tx1.wait()
      await tx2.wait()
      await tx3.wait()

      _voter = voter
      _tokens = mockLTokenAddresses.splice(0, TOKEN_PARAMETERS.length)
    })
    it('exec', async () => {
      const getCurrentTermFromVoter = async () => {
        const [idx, ts] = await Promise.all([
          _voter.currentTermIndex(),
          _voter.currentTermTimestamp(),
        ])
        return {
          index: idx.toNumber(),
          timestamp: ts.toNumber(),
          tsDate: new Date(ts.toNumber() * 1000).toISOString(),
        }
      }
      const getWeights = async (term: number, loop: number = 5) => {
        for (let i = 0; i < loop; i++) {
          console.log(`>> ${new Date((term + i * TERM) * 1000).toISOString()}`)
          const poolWeights = _tokens.map((v) =>
            _voter.poolWeights(v, term + i * TERM)
          )
          const results = await Promise.all(
            [_voter.totalWeight(term + i * TERM)].concat(poolWeights)
          )

          const [total, ...pools] = results
          console.log(`total: ${formatEther(total)}`)
          for (let i = 0; i < loop; i++) {
            const _total = total.isZero() ? BigNumber.from('1') : total
            const ratio =
              pools[i]
                .mul(10 ** 8)
                .div(_total)
                .toNumber() /
              10 ** 6
            console.log(`${i}    : ${ratio}: ${formatEther(pools[i])}`)
          }
          console.log(``)
        }
      }

      let tx: ContractTransaction
      const [uA, uB, uC] = _users

      console.log(`# Initial (after Deploy & .createLock)`)
      const initialTerm = await getCurrentTermFromVoter()
      console.log(initialTerm)

      console.log(`## vote from uA`)
      await (await _voter.connect(uA).vote([4, 1, 0, 0, 0])).wait()
      console.log(await getWeights(initialTerm.timestamp))

      console.log(`# Initial + 1 TERM`)
      ethers.provider.send('evm_mine', [
        initialTerm.timestamp + TERM + 1 * HOUR,
      ])
      console.log(await getCurrentTermFromVoter())
      console.log(`## vote from uB`)
      await (await _voter.connect(uB).vote([0, 0, 0, 1, 1])).wait()
      console.log(await getWeights(initialTerm.timestamp))

      console.log(`## change from uA`)
      await (await _voter.connect(uA).vote([0, 0, 0, 1, 1])).wait()
      console.log(await getWeights(initialTerm.timestamp))

      console.log(`# Initial + 2 TERM`)
      ethers.provider.send('evm_mine', [
        initialTerm.timestamp + 2 * TERM + 1 * HOUR,
      ])
      console.log(await getCurrentTermFromVoter())
      console.log(`## vote from uC`)
      await (await _voter.connect(uC).vote([1, 1, 1, 0, 1])).wait()
      console.log(await getWeights(initialTerm.timestamp))
    })
  })
})
