import '@nomiclabs/hardhat-ethers'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { Voter__factory } from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

const SUPPORTED_NETWORK = ['astar', 'shiden', 'localhost'] as const
type SupportedNetwork = typeof SUPPORTED_NETWORK[number]

const CONSTANTS: {
  [key in SupportedNetwork]: string[]
} = {
  astar: [
    '0xc0043Ad81De6DB53a604e42377290EcfD4Bc5fED'.toLowerCase(), // WASTR
    '0x2308De041865503B3b24F5da4D1ab7308c4ff756'.toLowerCase(), // WSDN
    '0x61f5df7076D2BA75323129CC2724db3abDdC3073'.toLowerCase(), // WETH
    '0x93E008010B17a48A140EEA4283040adD92eAC576'.toLowerCase(), // WBTC
    '0x430D50963d9635bBef5a2fF27BD0bDDc26ed691F'.toLowerCase(), // USDT
    '0xC404E12D3466acCB625c67dbAb2E1a8a457DEf3c'.toLowerCase(), // USDC
    '0x70A91e490Fd089fC8b2a3432858800AFB6Ceb539'.toLowerCase(), // OAL
    '0xb7aB962c42A8Bb443e0362f58a5A43814c573FFb'.toLowerCase(), // BUSD
    '0x4dd9c468A44F3FEF662c35c1E9a6108B70415C2c'.toLowerCase(), // DAI
    '0xF49Ab32B1B13A50eEe2022347A31a69524E83671'.toLowerCase(), // MATIC
    '0xd37991C23242439B0549c8328df5d83897D645AA'.toLowerCase(), // BNB
    '0x86EADed1F56ad656657b90D60483e1d0a5f7C20b'.toLowerCase(), // DOT
    '0x4aaD525895373ad3D8C4aF4743723436312F30e7'.toLowerCase(), // aUSD
  ],
  shiden: [
    '0x0a3c24FC967af171CF3Cf24fc46a9e5247d51BF1'.toLowerCase(), // WASTR
    '0xeAEaEfDfB40205EfEb18FD2e85D1d1173c53448A'.toLowerCase(), // WSDN
    '0xaE6AA78668bC2A1fE5800dcDdd87345C0cE801b9'.toLowerCase(), // WETH
    '0xeEF36e87e130Eed43B5a3F81be4702F2f7A0c205'.toLowerCase(), // WBTC
    '0xFa668E06fe382ECb6ADBad15108357c1125aF906'.toLowerCase(), // USDT
    '0xF4D80e698D40Aae4F8486E59D3A52BB4b637e867'.toLowerCase(), // USDC
    '0x5E580CFfd8948DdDFfd42F36655b28ea3C6eD5ae'.toLowerCase(), // OAL
    '0xB8447E00be2281e4744fCeC1Aa5BB9216be70d3d'.toLowerCase(), // BUSD
    '0x59448269aa5Cb875F27268368bB1913bF60580aD'.toLowerCase(), // DAI
    '0x61641f8Db169E26809f4CE542327caBCfD9BA8A2'.toLowerCase(), // MATIC
    '0x9AcE7af4A5Ec0df8e9D3da8218D064ce92D67097'.toLowerCase(), // BNB
    '0xbA331ffB7179FC4ec5c5bb54fe0A936F50ed964D'.toLowerCase(), // DOT
  ],
  localhost: [
    '0x000000000000000000000000000000000000000a',
    '0x000000000000000000000000000000000000000b',
    '0x000000000000000000000000000000000000000c',
    '0x000000000000000000000000000000000000000d',
    '0x000000000000000000000000000000000000000e',
    '0x000000000000000000000000000000000000000f',
  ],
}

task('migrate:add-tokens-at-launch', 'migrate:add-tokens-at-launch').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    console.log(`------- [migrate:add-tokens-at-launch] START -------`)

    if (
      !(SUPPORTED_NETWORK as ReadonlyArray<string>).includes(hre.network.name)
    )
      throw new Error(`Support only ${SUPPORTED_NETWORK} ...`)
    const deployer = (await hre.ethers.getSigners())[0]
    const networkName = hre.network.name as SupportedNetwork
    console.log(`network: ${networkName}`)
    console.log(`deployer: ${deployer.address}`)

    const {
      contracts: { voter },
    } = ContractsJsonHelper.load({
      network: networkName,
    })

    const voterInstance = Voter__factory.connect(voter, deployer)

    // Execute
    console.log(`> Execute`)
    const inputs = CONSTANTS[networkName]
    for await (const [index, input] of inputs.entries()) {
      console.log(`>> addToken ${index + 1}`)
      console.log(`token = ${input}`)
      const tx = await voterInstance.addToken(input)
      await tx.wait()
    }

    // Confirm
    console.log(`> Confirm`)
    const tokenList = await voterInstance.tokenList()
    console.log(`size = ${tokenList.length}`)
    console.log(`tokenList`)
    console.log(tokenList)
    console.log(`>> About each token`)
    for await (const token of tokenList) {
      const tIndex = await voterInstance.tokenIndex(token)
      console.log({
        tokenIndex: tIndex.toString(),
        token,
      })
    }

    console.log(`------- [migrate:add-tokens-at-launch] END -------`)
  }
)
