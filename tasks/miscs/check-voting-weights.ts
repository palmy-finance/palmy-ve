import { BigNumber, ethers } from 'ethers'
import { formatEther } from 'ethers/lib/utils'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { LToken__factory, Voter__factory } from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

// diff durations for checking term
const TERM = 2 * 7 * 24 * 60 * 60 // 2 week
const CONSTANTS_DIFF_TERM: { label: string; diff: number }[] = [
  { label: '-2 * term', diff: -2 },
  { label: '-1 * term', diff: -1 },
  { label: 'current', diff: 0 },
  { label: '+1 * term', diff: +1 },
  { label: '+2 * term', diff: +2 },
]

const getTokenFields = async (
  addresses: string[],
  provider: ethers.providers.JsonRpcProvider
): Promise<{ address: string; symbol: string }[]> => {
  const results: { address: string; symbol: string }[] = []
  for await (const addr of addresses) {
    const token = LToken__factory.connect(addr, provider)
    const symbol = await token.symbol()
    results.push({ address: addr, symbol })
  }
  return results
}

task('check:voting-weights', 'check:voting-weights').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const {
      network,
      ethers: { provider },
    } = hre
    console.log(`------- [check:voting-weights] START -------`)
    console.log(`network ... ${network.name}`)
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })

    const voter = Voter__factory.connect(addresses.voter, provider)
    const tokens = await getTokenFields(await voter.tokenList(), provider)

    const currentTimestamp = (
      await provider.getBlock(await provider.getBlockNumber())
    ).timestamp
    const [termIndex, termTimestamp] = await Promise.all([
      voter.currentTermIndex().then((v) => v.toNumber()),
      voter.currentTermTimestamp().then((v) => v.toNumber()),
    ])
    console.log(`> Current`)
    console.log({
      timestamp: new Date(currentTimestamp * 1000).toISOString(),
      termIndex: termIndex,
      termTimestamp: new Date(termTimestamp * 1000).toISOString(),
    })

    for await (const constants of CONSTANTS_DIFF_TERM) {
      const baseTerm = termTimestamp + constants.diff * TERM
      console.log(`# ${constants.label}`)
      console.log(`>> ${new Date(baseTerm * 1000).toISOString()}`)
      const poolWeights = tokens.map((v) =>
        voter.poolWeights(v.address, baseTerm)
      )
      const results = await Promise.all(
        [voter.totalWeight(baseTerm)].concat(poolWeights)
      )

      const [total, ...pools] = results
      console.log(`total: ${formatEther(total)}`)
      for (let i = 0; i < tokens.length; i++) {
        const _total = total.isZero() ? BigNumber.from('1') : total
        const ratio =
          pools[i]
            .mul(10 ** 8)
            .div(_total)
            .toNumber() /
          10 ** 6
        const token = tokens[i]
        console.log(
          `${i.toString().padStart(2, ' ')} ${token.symbol.padStart(
            11,
            ' '
          )} (${token.address}) : ${ratio} (${formatEther(pools[i])})`
        )
      }
      console.log(``)
    }
  }
)
