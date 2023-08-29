import { formatUnits } from 'ethers/lib/utils'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { LToken__factory, Voter__factory } from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

const ADDRESSES: string[] = []
task('check:tokens-in-voter', 'check:tokens-in-voter').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    const {
      network,
      ethers: { provider },
    } = hre
    console.log(`------- [check:tokens-in-voter] START -------`)
    console.log(`network ... ${network.name}`)
    const { contracts: addresses } = ContractsJsonHelper.load({
      network: network.name,
    })

    const voter = Voter__factory.connect(addresses.voter, provider)
    const addrs = ADDRESSES.length > 0 ? ADDRESSES : await voter.tokenList()
    for await (const addr of addrs) {
      const token = LToken__factory.connect(addr, provider)
      const [name, symbol, decimals] = await Promise.all([
        token.name(),
        token.symbol(),
        token.decimals(),
      ])
      const [totalSupply, scaledTotalSupply, balanceOf, scaledBalanceOf] =
        await Promise.all([
          token.totalSupply().then((v) => formatUnits(v, decimals)),
          token.scaledTotalSupply().then((v) => formatUnits(v, decimals)),
          token
            .balanceOf(addresses.voter)
            .then((v) => formatUnits(v, decimals)),
          token
            .scaledBalanceOf(addresses.voter)
            .then((v) => formatUnits(v, decimals)),
        ])
      console.log(`> addr: ${addr}`)
      console.log({
        name,
        symbol,
        decimals,
        totalSupply,
        scaledTotalSupply,
        balanceOf,
        scaledBalanceOf,
      })
    }
    console.log(`------- [check:tokens-in-voter] START -------`)
  }
)
