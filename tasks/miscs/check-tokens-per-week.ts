import { ethers } from 'ethers'
import { formatUnits } from 'ethers/lib/utils'
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

type TokenFieldType = { address: string; symbol: string; decimals: number }
const getTokenFields = async (
  addresses: string[],
  provider: ethers.providers.JsonRpcProvider
): Promise<TokenFieldType[]> => {
  const results: TokenFieldType[] = []
  for await (const addr of addresses) {
    const token = LToken__factory.connect(addr, provider)
    const [symbol] = await Promise.all([
      token.symbol(),
      // token.decimals(),
    ])
    results.push({ address: addr, symbol, decimals: 18 })
  }
  return results
}

task('check:tokens-per-week', 'check:token-per-week').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const {
      network,
      ethers: { provider },
    } = hre
    console.log(`------- [check:tokens-per-week] START -------`)
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

      const tokensWithTokenPerWeeks = await Promise.all(
        tokens.map((token) =>
          voter
            .tokensPerWeek(token.address, baseTerm)
            .then((v) => ({ ...token, value: v }))
        )
      )

      for (let i = 0; i < tokens.length; i++) {
        const _t = tokensWithTokenPerWeeks[i]
        console.log(
          `${i.toString().padStart(2, ' ')} ${_t.symbol.padStart(11, ' ')} (${
            _t.address
          }): ${formatUnits(
            _t.value,
            18 // _t.decimals
          )} (${_t.value.toString()}) (decimals = ${18})`
        )
      }
      console.log(``)
    }

    console.log(`------- [check:tokens-per-week] END -------`)
  }
)
