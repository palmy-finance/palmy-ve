import { BigNumber } from 'ethers'
import { formatEther, parseEther } from 'ethers/lib/utils'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
  ERC20__factory,
  Token__factory,
  VotingEscrowV2Rev2__factory,
  VotingEscrow__factory,
} from '../../types'
import { ContractsJsonHelper } from '../../utils/contracts-json-helper'

const SUPPORTED_NETWORK = ['astar', 'shiden', 'localhost'] as const
type SupportedNetwork = typeof SUPPORTED_NETWORK[number]
type ParameterForWithdraw = {
  targetLockerId: number
  currentLockerId: number
  for: string
  toMsgSender: boolean // withdrawer is for(owner) or msg.sender
}
const CONSTANTS_FOR_WITHDRAW: {
  [key in SupportedNetwork]: ParameterForWithdraw[]
} = {
  astar: [
    {
      targetLockerId: 162,
      currentLockerId: 163,
      for: '0xA6AC8E0C57aF0Fa64Db024B74c6B0B617fdBa123',
      toMsgSender: true,
    },
    {
      targetLockerId: 200,
      currentLockerId: 201,
      for: '0x083E6eBcC4249EC9641fb3C2f4332f3b273Ddd9d',
      toMsgSender: false,
    },
  ],
  shiden: [], // TODO
  localhost: [
    {
      targetLockerId: 1,
      currentLockerId: 2,
      for: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      toMsgSender: false,
    },
    {
      targetLockerId: 3,
      currentLockerId: 4,
      for: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      toMsgSender: false,
    },
    {
      targetLockerId: 5,
      currentLockerId: 6,
      for: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      toMsgSender: false,
    },
    {
      targetLockerId: 7,
      currentLockerId: 8,
      for: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
      toMsgSender: true,
    },
    {
      targetLockerId: 9,
      currentLockerId: 10,
      for: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
      toMsgSender: true,
    }, // from dev:multi-create-lock
  ],
}

task(
  'exec:withdraw-emergency-from-ve',
  'exec:withdraw-emergency-from-ve'
).setAction(async ({}, hre: HardhatRuntimeEnvironment) => {
  console.log(`------- [exec:withdraw-emergency-from-ve] START -------`)
  const { ethers, network } = hre
  if (!(SUPPORTED_NETWORK as ReadonlyArray<string>).includes(network.name))
    throw new Error(`Support only ${SUPPORTED_NETWORK} ...`)
  const networkName = network.name as SupportedNetwork

  const executor = (await ethers.getSigners())[0]
  console.log(`network: ${networkName}`)
  console.log(`executor: ${executor.address}`)

  const {
    contracts: { votingEscrow },
  } = ContractsJsonHelper.load({
    network: network.name,
  })
  const ve = VotingEscrowV2Rev2__factory.connect(votingEscrow, executor)
  if ((await ve.version()) != '2.0.1')
    throw new Error('Version is not VotingEscrowV2Rev2')

  const inputs = CONSTANTS_FOR_WITHDRAW[networkName]

  console.log(`target count: ${inputs.length}`)
  for await (const input of inputs) {
    console.log(`> execute`)
    console.log(input)
    if (input.toMsgSender) {
      console.log('---> call .withdrawEmergencyToMsgSender')
      const tx = await ve.withdrawEmergencyToMsgSender(
        input.targetLockerId,
        input.currentLockerId,
        input.for
      )
      console.log(`tx.hash: ${tx.hash}`)
      await tx.wait()
    } else {
      console.log('---> call .withdrawEmergency')
      const tx = await ve.withdrawEmergency(
        input.targetLockerId,
        input.currentLockerId,
        input.for
      )
      console.log(`tx.hash: ${tx.hash}`)
      await tx.wait()
    }
    console.log(`>> executed`)
  }

  console.log(`------- [exec:withdraw-emergency-from-ve] END -------`)
})

type ParameterForDepositFor = {
  for: string
  value: BigNumber
}
const CONSTANTS_FOR_DEPOSIT_FOR: {
  [key in SupportedNetwork]: { _from: string; params: ParameterForDepositFor[] }
} = {
  astar: {
    _from: '',
    params: [],
  }, // TODO
  shiden: {
    _from: '',
    params: [],
  }, // TODO
  localhost: {
    _from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    params: [
      {
        for: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
        value: parseEther('250'), // from LOCKED_AMOUNTS[0]
      },
      {
        for: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
        value: parseEther('250'), // from LOCKED_AMOUNTS[0]
      },
    ],
  },
}
task(
  'exec:deposit-for-in-operation',
  'exec:deposit-for-in-operation'
).setAction(async ({}, hre: HardhatRuntimeEnvironment) => {
  console.log(`------- [exec:deposit-for-in-operation] START -------`)
  const { ethers, network } = hre
  if (!(SUPPORTED_NETWORK as ReadonlyArray<string>).includes(network.name))
    throw new Error(`Support only ${SUPPORTED_NETWORK} ...`)
  const networkName = network.name as SupportedNetwork

  const executor = (await ethers.getSigners())[0]
  console.log(`network: ${networkName}`)
  console.log(`executor: ${executor.address}`)

  const {
    contracts: { votingEscrow },
    inputs: { lockingToken: _oal },
  } = ContractsJsonHelper.load({
    network: network.name,
  })
  const ve = VotingEscrowV2Rev2__factory.connect(votingEscrow, executor)
  const oal = ERC20__factory.connect(_oal, executor)

  const input = CONSTANTS_FOR_DEPOSIT_FOR[networkName]
  console.log(`from: ${input._from}`)
  const _signer = await ethers.getSigner(input._from)
  console.log(`> prepare: oal.approve`)
  await (
    await oal
      .connect(_signer)
      .approve(votingEscrow, ethers.constants.MaxUint256)
  ).wait()
  console.log(`>> prepared: oal.approve`)

  console.log(`# target count: ${input.params.length}`)
  for await (const param of input.params) {
    console.log(`> execute`)
    console.log({
      for: param.for,
      value: param.value.toString(),
    })
    const tx = await ve.connect(_signer).depositFor(param.for, param.value)
    console.log(`tx.hash: ${tx.hash}`)
    await tx.wait()
    console.log(`>> executed`)
  }

  console.log(`------- [exec:deposit-for-in-operation] END -------`)
})

const SIGNER_FOR_CHECKING_OAL = ''
task('temp:check-oal-balances', 'temp:check-oal-balances').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    console.log(`------- [temp:check-oal-balances] START -------`)
    const { ethers, network } = hre
    const signer = await ethers.getSigner(SIGNER_FOR_CHECKING_OAL)
    console.log(`network: ${hre.network.name}`)

    const {
      inputs: { lockingToken: _lockingToken },
    } = ContractsJsonHelper.load({
      network: network.name,
    })
    const oal = Token__factory.connect(_lockingToken, signer)

    const balanceOf = await oal.balanceOf(signer.address)
    console.log(`signer: ${signer.address}`)
    console.log(`> balanceOf: ${formatEther(balanceOf)}`)

    console.log(`------- [temp:check-oal-balances] END -------`)
  }
)

// For local
const HOUR = 60 * 60 // in minute
const DAY = HOUR * 24
const YEAR = DAY * 365
const MULTI_LOCKER_COUNT = 5
const LOCKED_AMOUNTS = [parseEther('250'), parseEther('750')]
const LOCK_DURATIONS = [2 * YEAR, 2 * YEAR]
task('dev:multi-create-lock', 'dev:multi-create-lock').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    console.log(`------- [dev:multi-create-lock] START -------`)
    const { ethers, network } = hre
    if (network.name !== 'localhost')
      throw new Error(`Support only localhost ...`)
    const [deployer, ...signers] = await hre.ethers.getSigners()
    console.log(`network: ${hre.network.name}`)
    console.log(`deployer: ${deployer.address}`)

    const {
      contracts: { votingEscrow: _votingEscrow },
      inputs: { lockingToken: _lockingToken },
    } = ContractsJsonHelper.load({
      network: network.name,
    })

    const ve = VotingEscrow__factory.connect(_votingEscrow, deployer)
    const oal = Token__factory.connect(_lockingToken, deployer)

    // Prepare for Lock
    for await (const _signer of signers) {
      console.log(`> user: ${_signer.address}`)
      await (await oal.transfer(_signer.address, parseEther('1000'))).wait()
      await (
        await oal.connect(_signer).approve(ve.address, parseEther('1000'))
      ).wait()
    }
    for (let i = 0; i < MULTI_LOCKER_COUNT; i++) {
      const _signer = signers[i]
      const _ve = ve.connect(_signer)
      await (await _ve.createLock(LOCKED_AMOUNTS[0], LOCK_DURATIONS[0])).wait()
      await (await _ve.createLock(LOCKED_AMOUNTS[1], LOCK_DURATIONS[1])).wait()
    }
    console.log(`------- [dev:multi-create-lock] END -------`)
  }
)
task('dev:check-oal-balances', 'dev:check-oal-balances').setAction(
  async ({}, hre: HardhatRuntimeEnvironment) => {
    console.log(`------- [dev:check-oal-balances] START -------`)
    const { ethers, network } = hre
    if (network.name !== 'localhost')
      throw new Error(`Support only localhost ...`)
    const [deployer, ...signers] = await hre.ethers.getSigners()
    console.log(`network: ${hre.network.name}`)
    console.log(`deployer: ${deployer.address}`)

    const {
      inputs: { lockingToken: _lockingToken },
    } = ContractsJsonHelper.load({
      network: network.name,
    })
    const oal = Token__factory.connect(_lockingToken, deployer)

    for (let i = 0; i < MULTI_LOCKER_COUNT; i++) {
      const _signer = signers[i]
      const balanceOf = await oal.balanceOf(_signer.address)
      console.log(`address: ${_signer.address}`)
      console.log(`> balanceOf: ${formatEther(balanceOf)}`)
    }
    // about deployer
    const balanceOf = await oal.balanceOf(deployer.address)
    console.log(`deployer: ${deployer.address}`)
    console.log(`> balanceOf: ${formatEther(balanceOf)}`)

    console.log(`------- [dev:check-oal-balances] END -------`)
  }
)
