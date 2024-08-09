import { constants, Wallet } from 'ethers'
import { waffle, ethers } from 'hardhat'
import { expect } from './shared/expect'
import { Fixture } from 'ethereum-waffle'
import { NonfungibleTokenPositionDescriptor, MockTimeNonfungiblePositionManager, TestERC20 } from '../typechain'
import completeFixture from './shared/completeFixture'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import { getMaxTick, getMinTick } from './shared/ticks'
import { sortedTokens } from './shared/tokenSort'
import { extractJSONFromURI } from './shared/extractJSONFromURI'

describe('NonfungibleTokenPositionDescriptor', () => {
  let wallets: Wallet[]

  const nftPositionDescriptorCompleteFixture: Fixture<{
    nftPositionDescriptor: NonfungibleTokenPositionDescriptor
    tokens: [TestERC20, TestERC20, TestERC20]
    nft: MockTimeNonfungiblePositionManager
  }> = async (wallets, provider) => {
    const { factory, nft, router, nftDescriptor } = await completeFixture(wallets, provider)
    const tokenFactory = await ethers.getContractFactory('TestERC20')
    const tokens: [TestERC20, TestERC20, TestERC20] = [
      (await tokenFactory.deploy(constants.MaxUint256.div(2))) as TestERC20, // do not use maxu256 to avoid overflowing
      (await tokenFactory.deploy(constants.MaxUint256.div(2))) as TestERC20,
      (await tokenFactory.deploy(constants.MaxUint256.div(2))) as TestERC20,
    ]
    tokens.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))

    return {
      nftPositionDescriptor: nftDescriptor,
      tokens,
      nft,
    }
  }

  let nftPositionDescriptor: NonfungibleTokenPositionDescriptor
  let tokens: [TestERC20, TestERC20, TestERC20]
  let nft: MockTimeNonfungiblePositionManager
  let wsei: TestERC20

  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    wallets = await (ethers as any).getSigners()

    loadFixture = waffle.createFixtureLoader(wallets)
  })

  beforeEach('load fixture', async () => {
    ;({ tokens, nft, nftPositionDescriptor } = await loadFixture(nftPositionDescriptorCompleteFixture))
    const tokenFactory = await ethers.getContractFactory('TestERC20')
    wsei = tokenFactory.attach(await nftPositionDescriptor.WSEI()) as TestERC20
  })

  describe('#tokenRatioPriority', () => {
    it('returns -100 for WSEI', async () => {
      expect(await nftPositionDescriptor.tokenRatioPriority(wsei.address)).to.eq(-100)
    })

    it('returns 0 for any non-ratioPriority token', async () => {
      expect(await nftPositionDescriptor.tokenRatioPriority(tokens[0].address)).to.eq(0)
    })
  })

  describe('#flipRatio', () => {
    it('returns false if neither token has priority ordering', async () => {
      expect(await nftPositionDescriptor.flipRatio(tokens[0].address, tokens[2].address)).to.eq(false)
    })

    it('returns true if token1 has lower priority ordering', async () => {
      expect(await nftPositionDescriptor.flipRatio('0000000000000000000000000000000000000001', wsei.address)).to.eq(
        true
      )
    })
  })

  describe('#tokenURI', () => {
    it('displays SEI as token symbol for WSEI token', async () => {
      const [token0, token1] = sortedTokens(wsei, tokens[1])
      await nft.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 1)
      )
      await wsei.approve(nft.address, 100)
      await tokens[1].approve(nft.address, 100)
      await nft.mint({
        token0: token0.address,
        token1: token1.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallets[0].address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })

      const metadata = extractJSONFromURI(await nft.tokenURI(1))
      expect(metadata.name).to.match(/(\sSEI\/TEST|TEST\/SEI)/)
      expect(metadata.description).to.match(/(TEST-SEI|\sSEI-TEST)/)
      expect(metadata.description).to.match(/(\nSEI\sAddress)/)
    })

    it('displays returned token symbols when neither token is WSEI ', async () => {
      const [token0, token1] = sortedTokens(tokens[2], tokens[1])
      await nft.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 1)
      )
      await tokens[1].approve(nft.address, 100)
      await tokens[2].approve(nft.address, 100)
      await nft.mint({
        token0: token0.address,
        token1: token1.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallets[0].address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })

      const metadata = extractJSONFromURI(await nft.tokenURI(1))
      expect(metadata.name).to.match(/TEST\/TEST/)
      expect(metadata.description).to.match(/TEST-TEST/)
    })

    it('can render a different label for native currencies', async () => {
      const [token0, token1] = sortedTokens(wsei, tokens[1])
      await nft.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 1)
      )
      await wsei.approve(nft.address, 100)
      await tokens[1].approve(nft.address, 100)
      await nft.mint({
        token0: token0.address,
        token1: token1.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallets[0].address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })

      const nftDescriptorLibraryFactory = await ethers.getContractFactory('NFTDescriptor')
      const nftDescriptorLibrary = await nftDescriptorLibraryFactory.deploy()
      const positionDescriptorFactory = await ethers.getContractFactory('NonfungibleTokenPositionDescriptor', {
        libraries: {
          NFTDescriptor: nftDescriptorLibrary.address,
        },
      })
      const nftDescriptor = (await positionDescriptorFactory.deploy(
        wsei.address,
        // 'FUNNYMONEY' as a bytes32 string
        '0x46554e4e594d4f4e455900000000000000000000000000000000000000000000'
      )) as NonfungibleTokenPositionDescriptor

      const metadata = extractJSONFromURI(await nftDescriptor.tokenURI(nft.address, 1))
      expect(metadata.name).to.match(/(\sFUNNYMONEY\/TEST|TEST\/FUNNYMONEY)/)
      expect(metadata.description).to.match(/(TEST-FUNNYMONEY|\sFUNNYMONEY-TEST)/)
      expect(metadata.description).to.match(/(\nFUNNYMONEY\sAddress)/)
    })
  })
})
