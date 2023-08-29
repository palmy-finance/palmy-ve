import { parseEther } from 'ethers/lib/utils'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { MockLToken__factory, Token__factory } from '../../types'

task('deploy:mock-oal', 'Deploy mocked oal').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    console.log(`------- [deploy:mock-oal] START -------`)
    const deployer = (await hre.ethers.getSigners())[0]
    console.log(`network: ${hre.network.name}`)
    console.log(`deployer: ${deployer.address}`)

    const oal = await new Token__factory(deployer).deploy(
      'MockOAL',
      'MockOAL',
      parseEther('1000000000'),
      deployer.address
    )
    await oal.deployTransaction.wait()

    console.log(`mock-oal ... ${oal.address}`)
    console.log(`------- [deploy:mock-oal] END -------`)
    return oal.address
  }
)

task(
  'deploy:all-and-upgrade-with-mock',
  'Deploy & Upgrade all contracts with mock'
).setAction(async ({}, hre: HardhatRuntimeEnvironment) => {
  console.log(`------- [deploy:all-and-upgrade-with-mock] START -------`)
  const oal = await hre.run('deploy:mock-oal')
  await hre.run('deploy:all', {
    lockingToken: oal,
  })
  // Upgrade to latest
  await hre.run('upgrade:ve-from-v2rev2-to-v2rev3')
  console.log(`------- [deploy:all-and-upgrade-with-mock] END -------`)
})

const NOT_APPLICABLE_NETWORKS = ['astar', 'shiden']
const LTOKEN_NAMES = [
  'lWASTR',
  'lWSDN',
  'lWBTC',
  'lWETH',
  'lUSDT',
  'lUSDC',
  'lOAL',
  'lBUSD',
  'lDAI',
  'lMATIC',
  'lBNB',
  'lDOT',
  'lAUSD',
]
const LTOKEN_COUNT = 12
task('deploy:mock-ltoken', async ({}, hre: HardhatRuntimeEnvironment) => {
  console.log(`------- [deploy:mock-ltoken] START -------`)
  console.log(`network: ${hre.network.name}`)
  if (NOT_APPLICABLE_NETWORKS.includes(hre.network.name))
    throw new Error('This task cannot be performed in astar, shiden')
  const deployer = (await hre.ethers.getSigners())[0]
  const factory = new MockLToken__factory(deployer)
  const ltokens = []
  // deploy
  for (let i = 0; i < LTOKEN_COUNT; i++) {
    const name = LTOKEN_NAMES[i]
    const ltoken = await factory.deploy(name, name)
    await ltoken.deployTransaction.wait()
    ltokens.push(ltoken)
  }
  // confirm
  for await (const ltoken of ltokens) {
    const [name, symbol] = await Promise.all([ltoken.name(), ltoken.symbol()])
    console.log(`> ${ltoken.address}`)
    console.log({
      name,
      symbol,
    })
  }
  console.log(ltokens.map((v) => v.address))

  console.log(`------- [deploy:mock-ltoken] END -------`)
})
