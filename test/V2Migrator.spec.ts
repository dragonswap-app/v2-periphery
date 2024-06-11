import { Fixture } from 'ethereum-waffle'
import { constants, Contract, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import {
  IDragonswapPair,
  IDragonswapV2Factory,
  IWSEI,
  MockTimeNonfungiblePositionManager,
  TestERC20,
  V2Migrator,
} from '../typechain'
import completeFixture from './shared/completeFixture'
import { v1FactoryFixture } from './shared/externalFixtures'

import { abi as PAIR_V1_ABI } from './contracts/DragonswapPair.json'
import { expect } from 'chai'
import { FeeAmount } from './shared/constants'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import snapshotGasCost from './shared/snapshotGasCost'
import { sortedTokens } from './shared/tokenSort'
import { getMaxTick, getMinTick } from './shared/ticks'

describe('V2Migrator', () => {
  let wallet: Wallet

  const migratorFixture: Fixture<{
    factoryV1: Contract
    factoryV2: IDragonswapV2Factory
    token: TestERC20
    wsei: IWSEI
    nft: MockTimeNonfungiblePositionManager
    migrator: V2Migrator
  }> = async (wallets, provider) => {
    const { factory, tokens, nft, wsei } = await completeFixture(wallets, provider)

    const { factory: factoryV1 } = await v1FactoryFixture(wallets, provider)

    const token = tokens[0]
    await token.approve(factoryV1.address, constants.MaxUint256)
    await wsei.deposit({ value: 10000 })
    await wsei.approve(nft.address, constants.MaxUint256)

    // deploy the migrator
    const migrator = (await (await ethers.getContractFactory('V2Migrator')).deploy(
      factory.address,
      wsei.address,
      nft.address
    )) as V2Migrator

    return {
      factoryV1,
      factoryV2: factory,
      token,
      wsei,
      nft,
      migrator,
    }
  }

  let factoryV1: Contract
  let factoryV2: IDragonswapV2Factory
  let token: TestERC20
  let wsei: IWSEI
  let nft: MockTimeNonfungiblePositionManager
  let migrator: V2Migrator
  let pair: IDragonswapPair

  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  const expectedLiquidity = 10000 - 1000

  before('create fixture loader', async () => {
    const wallets = await (ethers as any).getSigners()
    wallet = wallets[0]

    loadFixture = waffle.createFixtureLoader(wallets)
  })

  beforeEach('load fixture', async () => {
    ;({ factoryV1, factoryV2, token, wsei, nft, migrator } = await loadFixture(migratorFixture))
  })

  beforeEach('add V1 liquidity', async () => {
    await factoryV1.createPair(token.address, wsei.address)

    const pairAddress = await factoryV1.getPair(token.address, wsei.address)

    pair = new ethers.Contract(pairAddress, PAIR_V1_ABI, wallet) as IDragonswapPair

    await token.transfer(pair.address, 10000)
    await wsei.transfer(pair.address, 10000)

    await pair.mint(wallet.address)

    expect(await pair.balanceOf(wallet.address)).to.be.eq(expectedLiquidity)
  })

  afterEach('ensure allowances are cleared', async () => {
    const allowanceToken = await token.allowance(migrator.address, nft.address)
    const allowanceWSEI = await wsei.allowance(migrator.address, nft.address)
    expect(allowanceToken).to.be.eq(0)
    expect(allowanceWSEI).to.be.eq(0)
  })

  afterEach('ensure balances are cleared', async () => {
    const balanceToken = await token.balanceOf(migrator.address)
    const balanceWSEI = await wsei.balanceOf(migrator.address)
    expect(balanceToken).to.be.eq(0)
    expect(balanceWSEI).to.be.eq(0)
  })

  afterEach('ensure sei balance is cleared', async () => {
    const balanceSEI = await ethers.provider.getBalance(migrator.address)
    expect(balanceSEI).to.be.eq(0)
  })

  describe('#migrate', () => {
    let tokenLower: boolean
    beforeEach(() => {
      tokenLower = token.address.toLowerCase() < wsei.address.toLowerCase()
    })

    it('fails if v2 pool is not initialized', async () => {
      await pair.approve(migrator.address, expectedLiquidity)
      await expect(
        migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : wsei.address,
          token1: tokenLower ? wsei.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: -1,
          tickUpper: 1,
          amount0Min: 9000,
          amount1Min: 9000,
          recipient: wallet.address,
          deadline: 1,
          refundAsSEI: false,
        })
      ).to.be.reverted
    })

    it('works once v2 pool is initialized', async () => {
      const [token0, token1] = sortedTokens(wsei, token)
      await migrator.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 1)
      )

      await pair.approve(migrator.address, expectedLiquidity)
      await migrator.migrate({
        pair: pair.address,
        liquidityToMigrate: expectedLiquidity,
        percentageToMigrate: 100,
        token0: tokenLower ? token.address : wsei.address,
        token1: tokenLower ? wsei.address : token.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        amount0Min: 9000,
        amount1Min: 9000,
        recipient: wallet.address,
        deadline: 1,
        refundAsSEI: false,
      })

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(9000)

      const poolAddress = await factoryV2.getPool(token.address, wsei.address, FeeAmount.MEDIUM)
      expect(await token.balanceOf(poolAddress)).to.be.eq(9000)
      expect(await wsei.balanceOf(poolAddress)).to.be.eq(9000)
    })

    it('works for partial', async () => {
      const [token0, token1] = sortedTokens(wsei, token)
      await migrator.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 1)
      )

      const tokenBalanceBefore = await token.balanceOf(wallet.address)
      const wseiBalanceBefore = await wsei.balanceOf(wallet.address)

      await pair.approve(migrator.address, expectedLiquidity)
      await migrator.migrate({
        pair: pair.address,
        liquidityToMigrate: expectedLiquidity,
        percentageToMigrate: 50,
        token0: tokenLower ? token.address : wsei.address,
        token1: tokenLower ? wsei.address : token.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        amount0Min: 4500,
        amount1Min: 4500,
        recipient: wallet.address,
        deadline: 1,
        refundAsSEI: false,
      })

      const tokenBalanceAfter = await token.balanceOf(wallet.address)
      const wseiBalanceAfter = await wsei.balanceOf(wallet.address)

      expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(4500)
      expect(wseiBalanceAfter.sub(wseiBalanceBefore)).to.be.eq(4500)

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(4500)

      const poolAddress = await factoryV2.getPool(token.address, wsei.address, FeeAmount.MEDIUM)
      expect(await token.balanceOf(poolAddress)).to.be.eq(4500)
      expect(await wsei.balanceOf(poolAddress)).to.be.eq(4500)
    })

    it('double the price', async () => {
      const [token0, token1] = sortedTokens(wsei, token)
      await migrator.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(2, 1)
      )

      const tokenBalanceBefore = await token.balanceOf(wallet.address)
      const wseiBalanceBefore = await wsei.balanceOf(wallet.address)

      await pair.approve(migrator.address, expectedLiquidity)
      await migrator.migrate({
        pair: pair.address,
        liquidityToMigrate: expectedLiquidity,
        percentageToMigrate: 100,
        token0: tokenLower ? token.address : wsei.address,
        token1: tokenLower ? wsei.address : token.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        amount0Min: 4500,
        amount1Min: 8999,
        recipient: wallet.address,
        deadline: 1,
        refundAsSEI: false,
      })

      const tokenBalanceAfter = await token.balanceOf(wallet.address)
      const wseiBalanceAfter = await wsei.balanceOf(wallet.address)

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(6363)

      const poolAddress = await factoryV2.getPool(token.address, wsei.address, FeeAmount.MEDIUM)
      if (token.address.toLowerCase() < wsei.address.toLowerCase()) {
        expect(await token.balanceOf(poolAddress)).to.be.eq(4500)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(4500)
        expect(await wsei.balanceOf(poolAddress)).to.be.eq(8999)
        expect(wseiBalanceAfter.sub(wseiBalanceBefore)).to.be.eq(1)
      } else {
        expect(await token.balanceOf(poolAddress)).to.be.eq(8999)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(1)
        expect(await wsei.balanceOf(poolAddress)).to.be.eq(4500)
        expect(wseiBalanceAfter.sub(wseiBalanceBefore)).to.be.eq(4500)
      }
    })

    it('half the price', async () => {
      const [token0, token1] = sortedTokens(wsei, token)
      await migrator.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 2)
      )

      const tokenBalanceBefore = await token.balanceOf(wallet.address)
      const wseiBalanceBefore = await wsei.balanceOf(wallet.address)

      await pair.approve(migrator.address, expectedLiquidity)
      await migrator.migrate({
        pair: pair.address,
        liquidityToMigrate: expectedLiquidity,
        percentageToMigrate: 100,
        token0: tokenLower ? token.address : wsei.address,
        token1: tokenLower ? wsei.address : token.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        amount0Min: 8999,
        amount1Min: 4500,
        recipient: wallet.address,
        deadline: 1,
        refundAsSEI: false,
      })

      const tokenBalanceAfter = await token.balanceOf(wallet.address)
      const wseiBalanceAfter = await wsei.balanceOf(wallet.address)

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(6363)

      const poolAddress = await factoryV2.getPool(token.address, wsei.address, FeeAmount.MEDIUM)
      if (token.address.toLowerCase() < wsei.address.toLowerCase()) {
        expect(await token.balanceOf(poolAddress)).to.be.eq(8999)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(1)
        expect(await wsei.balanceOf(poolAddress)).to.be.eq(4500)
        expect(wseiBalanceAfter.sub(wseiBalanceBefore)).to.be.eq(4500)
      } else {
        expect(await token.balanceOf(poolAddress)).to.be.eq(4500)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(4500)
        expect(await wsei.balanceOf(poolAddress)).to.be.eq(8999)
        expect(wseiBalanceAfter.sub(wseiBalanceBefore)).to.be.eq(1)
      }
    })

    it('double the price - as SEI', async () => {
      const [token0, token1] = sortedTokens(wsei, token)
      await migrator.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(2, 1)
      )

      const tokenBalanceBefore = await token.balanceOf(wallet.address)

      await pair.approve(migrator.address, expectedLiquidity)
      await expect(
        migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : wsei.address,
          token1: tokenLower ? wsei.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(FeeAmount.MEDIUM),
          tickUpper: getMaxTick(FeeAmount.MEDIUM),
          amount0Min: 4500,
          amount1Min: 8999,
          recipient: wallet.address,
          deadline: 1,
          refundAsSEI: true,
        })
      )
        .to.emit(wsei, 'Withdrawal')
        .withArgs(migrator.address, tokenLower ? 1 : 4500)

      const tokenBalanceAfter = await token.balanceOf(wallet.address)

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(6363)

      const poolAddress = await factoryV2.getPool(token.address, wsei.address, FeeAmount.MEDIUM)
      if (tokenLower) {
        expect(await token.balanceOf(poolAddress)).to.be.eq(4500)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(4500)
        expect(await wsei.balanceOf(poolAddress)).to.be.eq(8999)
      } else {
        expect(await token.balanceOf(poolAddress)).to.be.eq(8999)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(1)
        expect(await wsei.balanceOf(poolAddress)).to.be.eq(4500)
      }
    })

    it('half the price - as SEI', async () => {
      const [token0, token1] = sortedTokens(wsei, token)
      await migrator.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 2)
      )

      const tokenBalanceBefore = await token.balanceOf(wallet.address)

      await pair.approve(migrator.address, expectedLiquidity)
      await expect(
        migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : wsei.address,
          token1: tokenLower ? wsei.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(FeeAmount.MEDIUM),
          tickUpper: getMaxTick(FeeAmount.MEDIUM),
          amount0Min: 8999,
          amount1Min: 4500,
          recipient: wallet.address,
          deadline: 1,
          refundAsSEI: true,
        })
      )
        .to.emit(wsei, 'Withdrawal')
        .withArgs(migrator.address, tokenLower ? 4500 : 1)

      const tokenBalanceAfter = await token.balanceOf(wallet.address)

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(6363)

      const poolAddress = await factoryV2.getPool(token.address, wsei.address, FeeAmount.MEDIUM)
      if (tokenLower) {
        expect(await token.balanceOf(poolAddress)).to.be.eq(8999)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(1)
        expect(await wsei.balanceOf(poolAddress)).to.be.eq(4500)
      } else {
        expect(await token.balanceOf(poolAddress)).to.be.eq(4500)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(4500)
        expect(await wsei.balanceOf(poolAddress)).to.be.eq(8999)
      }
    })

    it('gas', async () => {
      const [token0, token1] = sortedTokens(wsei, token)
      await migrator.createAndInitializePoolIfNecessary(
        token0.address,
        token1.address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 1)
      )

      await pair.approve(migrator.address, expectedLiquidity)
      await snapshotGasCost(
        migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : wsei.address,
          token1: tokenLower ? wsei.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(FeeAmount.MEDIUM),
          tickUpper: getMaxTick(FeeAmount.MEDIUM),
          amount0Min: 9000,
          amount1Min: 9000,
          recipient: wallet.address,
          deadline: 1,
          refundAsSEI: false,
        })
      )
    })
  })
})
