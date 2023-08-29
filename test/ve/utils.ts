import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { HardhatEthersHelpers } from '@nomiclabs/hardhat-ethers/types'
import { BigNumber } from 'ethers/lib/ethers'
import { ethers } from 'hardhat'
import { Token } from '../../types'

// Constants
export const HOUR = 60 * 60 // in minute
export const DAY = HOUR * 24
export const WEEK = 7 * DAY
export const MONTH = 4 * WEEK // 30 * DAY
export const YEAR = DAY * 365
export const TERM = 2 * WEEK

// Prepare
export const multiTransferOal = async ({
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

export const currentTimestamp = async (
  arg?: typeof ethers & HardhatEthersHelpers
) => {
  const _ethers = arg ?? ethers
  return (
    await _ethers.provider.getBlock(await _ethers.provider.getBlockNumber())
  ).timestamp
}

export const getCurrentTerm = async (argTs?: number) => {
  const ts = argTs ?? (await currentTimestamp())
  return Math.floor(ts / TERM) * TERM
}
