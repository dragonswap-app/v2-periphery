import { Contract } from 'ethers'
import { waffle, ethers } from 'hardhat'

import { Fixture } from 'ethereum-waffle'
import { PeripheryImmutableStateTest, IWSEI } from '../typechain'
import { expect } from './shared/expect'
import { v2RouterFixture } from './shared/externalFixtures'

describe('PeripheryImmutableState', () => {
  const nonfungiblePositionManagerFixture: Fixture<{
    wsei: IWSEI
    factory: Contract
    state: PeripheryImmutableStateTest
  }> = async (wallets, provider) => {
    const { wsei, factory } = await v2RouterFixture(wallets, provider)

    const stateFactory = await ethers.getContractFactory('PeripheryImmutableStateTest')
    const state = (await stateFactory.deploy(factory.address, wsei.address)) as PeripheryImmutableStateTest

    return {
      wsei,
      factory,
      state,
    }
  }

  let factory: Contract
  let wsei: IWSEI
  let state: PeripheryImmutableStateTest

  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    loadFixture = waffle.createFixtureLoader(await (ethers as any).getSigners())
  })

  beforeEach('load fixture', async () => {
    ;({ state, wsei, factory } = await loadFixture(nonfungiblePositionManagerFixture))
  })

  it('bytecode size', async () => {
    expect(((await state.provider.getCode(state.address)).length - 2) / 2).to.matchSnapshot()
  })

  describe('#WSEI', () => {
    it('points to WSEI', async () => {
      expect(await state.WSEI()).to.eq(wsei.address)
    })
  })

  describe('#factory', () => {
    it('points to v2 core factory', async () => {
      expect(await state.factory()).to.eq(factory.address)
    })
  })
})
