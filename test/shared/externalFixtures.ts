import { abi as FACTORY_V2_ABI, bytecode as FACTORY_V2_BYTECODE } from '../contracts/DragonswapV2Factory.json'
import { abi as FACTORY_V1_ABI, bytecode as FACTORY_V1_BYTECODE } from '../contracts/DragonswapFactory.json'
import { Fixture } from 'ethereum-waffle'
import { ethers, waffle } from 'hardhat'
import { IDragonswapV2Factory, IWSEI, MockTimeSwapRouter } from '../../typechain'

import WSEI from '../contracts/WSEI.json'
import { Contract } from '@ethersproject/contracts'

const wseiFixture: Fixture<{ wsei: IWSEI }> = async ([wallet]) => {
  const wsei = (await waffle.deployContract(wallet, {
    bytecode: WSEI.bytecode,
    abi: WSEI.abi,
  })) as IWSEI

  return { wsei }
}

export const v1FactoryFixture: Fixture<{ factory: Contract }> = async ([wallet]) => {
  const factory = await waffle.deployContract(
    wallet,
    {
      bytecode: FACTORY_V1_BYTECODE,
      abi: FACTORY_V1_ABI,
    },
    ["0x0000000000000000000000000000000000000001"]
  )

  return { factory }
}

const v2CoreFactoryFixture: Fixture<IDragonswapV2Factory> = async ([wallet]) => {
  return (await waffle.deployContract(wallet, {
    bytecode: FACTORY_V2_BYTECODE,
    abi: FACTORY_V2_ABI,
  })) as IDragonswapV2Factory
}

export const v2RouterFixture: Fixture<{
  wsei: IWSEI
  factory: IDragonswapV2Factory
  router: MockTimeSwapRouter
}> = async ([wallet], provider) => {
  const { wsei } = await wseiFixture([wallet], provider)
  const factory = await v2CoreFactoryFixture([wallet], provider)

  const router = (await (await ethers.getContractFactory('MockTimeSwapRouter')).deploy(
    factory.address,
    wsei.address
  )) as MockTimeSwapRouter

  return { factory, wsei, router }
}
