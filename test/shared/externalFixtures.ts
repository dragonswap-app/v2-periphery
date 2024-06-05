import { abi as FACTORY_V2_ABI, bytecode as FACTORY_V2_BYTECODE } from '../contracts/DragonswapV2Factory.json'
import { abi as FACTORY_V1_ABI, bytecode as FACTORY_V1_BYTECODE } from '../contracts/DragonswapFactory.json'
import { Fixture } from 'ethereum-waffle'
import { ethers, waffle } from 'hardhat'
import { IDragonswapV2Factory, IWETH9, MockTimeSwapRouter } from '../../typechain'

import WETH9 from '../contracts/WETH9.json'
import { Contract } from '@ethersproject/contracts'

const wethFixture: Fixture<{ weth9: IWETH9 }> = async ([wallet]) => {
  const weth9 = (await waffle.deployContract(wallet, {
    bytecode: WETH9.bytecode,
    abi: WETH9.abi,
  })) as IWETH9

  return { weth9 }
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
  weth9: IWETH9
  factory: IDragonswapV2Factory
  router: MockTimeSwapRouter
}> = async ([wallet], provider) => {
  const { weth9 } = await wethFixture([wallet], provider)
  const factory = await v2CoreFactoryFixture([wallet], provider)

  const router = (await (await ethers.getContractFactory('MockTimeSwapRouter')).deploy(
    factory.address,
    weth9.address
  )) as MockTimeSwapRouter

  return { factory, weth9, router }
}
