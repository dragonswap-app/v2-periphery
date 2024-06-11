import { Fixture } from 'ethereum-waffle'
import { BigNumber, constants, Contract, ContractTransaction, Wallet } from 'ethers'
import { waffle, ethers } from 'hardhat'
import { IWSEI, MockTimeNonfungiblePositionManager, MockTimeSwapRouter, TestERC20 } from '../typechain'
import completeFixture from './shared/completeFixture'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { expect } from './shared/expect'
import { encodePath } from './shared/path'
import { getMaxTick, getMinTick } from './shared/ticks'
import { computePoolAddress } from './shared/computePoolAddress'

describe('SwapRouter', function () {
  this.timeout(40000)
  let wallet: Wallet
  let trader: Wallet

  const swapRouterFixture: Fixture<{
    wsei: IWSEI
    factory: Contract
    router: MockTimeSwapRouter
    nft: MockTimeNonfungiblePositionManager
    tokens: [TestERC20, TestERC20, TestERC20]
  }> = async (wallets, provider) => {
    const { wsei, factory, router, tokens, nft } = await completeFixture(wallets, provider)

    // approve & fund wallets
    for (const token of tokens) {
      await token.approve(router.address, constants.MaxUint256)
      await token.approve(nft.address, constants.MaxUint256)
      await token.connect(trader).approve(router.address, constants.MaxUint256)
      await token.transfer(trader.address, expandTo18Decimals(1_000_000))
    }

    return {
      wsei,
      factory,
      router,
      tokens,
      nft,
    }
  }

  let factory: Contract
  let wsei: IWSEI
  let router: MockTimeSwapRouter
  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let getBalances: (
    who: string
  ) => Promise<{
    wsei: BigNumber
    token0: BigNumber
    token1: BigNumber
    token2: BigNumber
  }>

  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    ;[wallet, trader] = await (ethers as any).getSigners()
    loadFixture = waffle.createFixtureLoader([wallet, trader])
  })

  // helper for getting wsei and token balances
  beforeEach('load fixture', async () => {
    ;({ router, wsei, factory, tokens, nft } = await loadFixture(swapRouterFixture))

    getBalances = async (who: string) => {
      const balances = await Promise.all([
        wsei.balanceOf(who),
        tokens[0].balanceOf(who),
        tokens[1].balanceOf(who),
        tokens[2].balanceOf(who),
      ])
      return {
        wsei: balances[0],
        token0: balances[1],
        token1: balances[2],
        token2: balances[3],
      }
    }
  })

  // ensure the swap router never ends up with a balance
  afterEach('load fixture', async () => {
    const balances = await getBalances(router.address)
    expect(Object.values(balances).every((b) => b.eq(0))).to.be.eq(true)
    const balance = await waffle.provider.getBalance(router.address)
    expect(balance.eq(0)).to.be.eq(true)
  })

  it('bytecode size', async () => {
    expect(((await router.provider.getCode(router.address)).length - 2) / 2).to.matchSnapshot()
  })

  describe('swaps', () => {
    const liquidity = 1000000
    async function createPool(tokenAddressA: string, tokenAddressB: string) {
      if (tokenAddressA.toLowerCase() > tokenAddressB.toLowerCase())
        [tokenAddressA, tokenAddressB] = [tokenAddressB, tokenAddressA]

      await nft.createAndInitializePoolIfNecessary(
        tokenAddressA,
        tokenAddressB,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 1)
      )

      const liquidityParams = {
        token0: tokenAddressA,
        token1: tokenAddressB,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallet.address,
        amount0Desired: 1000000,
        amount1Desired: 1000000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      }

      return nft.mint(liquidityParams)
    }

    async function createPoolWSEI(tokenAddress: string) {
      await wsei.deposit({ value: liquidity })
      await wsei.approve(nft.address, constants.MaxUint256)
      return createPool(wsei.address, tokenAddress)
    }

    beforeEach('create 0-1 and 1-2 pools', async () => {
      await createPool(tokens[0].address, tokens[1].address)
      await createPool(tokens[1].address, tokens[2].address)
    })

    describe('#exactInput', () => {
      async function exactInput(
        tokens: string[],
        amountIn: number = 3,
        amountOutMinimum: number = 1
      ): Promise<ContractTransaction> {
        const inputIsWSEI = wsei.address === tokens[0]
        const outputIsWSEI = tokens[tokens.length - 1] === wsei.address

        const value = inputIsWSEI ? amountIn : 0

        const params = {
          path: encodePath(tokens, new Array(tokens.length - 1).fill(FeeAmount.MEDIUM)),
          recipient: outputIsWSEI ? constants.AddressZero : trader.address,
          deadline: 1,
          amountIn,
          amountOutMinimum,
        }

        const data = [router.interface.encodeFunctionData('exactInput', [params])]
        if (outputIsWSEI)
          data.push(router.interface.encodeFunctionData('unwrapWSEI', [amountOutMinimum, trader.address]))

        // ensure that the swap fails if the limit is any tighter
        params.amountOutMinimum += 1
        await expect(router.connect(trader).exactInput(params, { value })).to.be.revertedWith('Too little received')
        params.amountOutMinimum -= 1

        // optimized for the gas test
        return data.length === 1
          ? router.connect(trader).exactInput(params, { value })
          : router.connect(trader).multicall(data, { value })
      }

      describe('single-pool', () => {
        it('0 -> 1', async () => {
          const pool = await factory.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM)

          // get balances before
          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(trader.address)

          await exactInput(tokens.slice(0, 2).map((token) => token.address))

          // get balances after
          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(3))
          expect(traderAfter.token1).to.be.eq(traderBefore.token1.add(1))
          expect(poolAfter.token0).to.be.eq(poolBefore.token0.add(3))
          expect(poolAfter.token1).to.be.eq(poolBefore.token1.sub(1))
        })

        it('1 -> 0', async () => {
          const pool = await factory.getPool(tokens[1].address, tokens[0].address, FeeAmount.MEDIUM)

          // get balances before
          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(trader.address)

          await exactInput(
            tokens
              .slice(0, 2)
              .reverse()
              .map((token) => token.address)
          )

          // get balances after
          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0.add(1))
          expect(traderAfter.token1).to.be.eq(traderBefore.token1.sub(3))
          expect(poolAfter.token0).to.be.eq(poolBefore.token0.sub(1))
          expect(poolAfter.token1).to.be.eq(poolBefore.token1.add(3))
        })
      })

      describe('multi-pool', () => {
        it('0 -> 1 -> 2', async () => {
          const traderBefore = await getBalances(trader.address)

          await exactInput(
            tokens.map((token) => token.address),
            5,
            1
          )

          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(5))
          expect(traderAfter.token2).to.be.eq(traderBefore.token2.add(1))
        })

        it('2 -> 1 -> 0', async () => {
          const traderBefore = await getBalances(trader.address)

          await exactInput(tokens.map((token) => token.address).reverse(), 5, 1)

          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token2).to.be.eq(traderBefore.token2.sub(5))
          expect(traderAfter.token0).to.be.eq(traderBefore.token0.add(1))
        })

        it('events', async () => {
          await expect(
            exactInput(
              tokens.map((token) => token.address),
              5,
              1
            )
          )
            .to.emit(tokens[0], 'Transfer')
            .withArgs(
              trader.address,
              computePoolAddress(factory.address, [tokens[0].address, tokens[1].address], FeeAmount.MEDIUM),
              5
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              computePoolAddress(factory.address, [tokens[0].address, tokens[1].address], FeeAmount.MEDIUM),
              router.address,
              3
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              router.address,
              computePoolAddress(factory.address, [tokens[1].address, tokens[2].address], FeeAmount.MEDIUM),
              3
            )
            .to.emit(tokens[2], 'Transfer')
            .withArgs(
              computePoolAddress(factory.address, [tokens[1].address, tokens[2].address], FeeAmount.MEDIUM),
              trader.address,
              1
            )
        })
      })

      describe('SEI input', () => {
        describe('WSEI', () => {
          beforeEach(async () => {
            await createPoolWSEI(tokens[0].address)
          })

          it('WSEI -> 0', async () => {
            const pool = await factory.getPool(wsei.address, tokens[0].address, FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactInput([wsei.address, tokens[0].address]))
              .to.emit(wsei, 'Deposit')
              .withArgs(router.address, 3)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0.add(1))
            expect(poolAfter.wsei).to.be.eq(poolBefore.wsei.add(3))
            expect(poolAfter.token0).to.be.eq(poolBefore.token0.sub(1))
          })

          it('WSEI -> 0 -> 1', async () => {
            const traderBefore = await getBalances(trader.address)

            await expect(exactInput([wsei.address, tokens[0].address, tokens[1].address], 5))
              .to.emit(wsei, 'Deposit')
              .withArgs(router.address, 5)

            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token1).to.be.eq(traderBefore.token1.add(1))
          })
        })
      })

      describe('SEI output', () => {
        describe('WSEI', () => {
          beforeEach(async () => {
            await createPoolWSEI(tokens[0].address)
            await createPoolWSEI(tokens[1].address)
          })

          it('0 -> WSEI', async () => {
            const pool = await factory.getPool(tokens[0].address, wsei.address, FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactInput([tokens[0].address, wsei.address]))
              .to.emit(wsei, 'Withdrawal')
              .withArgs(router.address, 1)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(3))
            expect(poolAfter.wsei).to.be.eq(poolBefore.wsei.sub(1))
            expect(poolAfter.token0).to.be.eq(poolBefore.token0.add(3))
          })

          it('0 -> 1 -> WSEI', async () => {
            // get balances before
            const traderBefore = await getBalances(trader.address)

            await expect(exactInput([tokens[0].address, tokens[1].address, wsei.address], 5))
              .to.emit(wsei, 'Withdrawal')
              .withArgs(router.address, 1)

            // get balances after
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(5))
          })
        })
      })
    })

    describe('#exactInputSingle', () => {
      async function exactInputSingle(
        tokenIn: string,
        tokenOut: string,
        amountIn: number = 3,
        amountOutMinimum: number = 1,
        sqrtPriceLimitX96?: BigNumber
      ): Promise<ContractTransaction> {
        const inputIsWSEI = wsei.address === tokenIn
        const outputIsWSEI = tokenOut === wsei.address

        const value = inputIsWSEI ? amountIn : 0

        const params = {
          tokenIn,
          tokenOut,
          fee: FeeAmount.MEDIUM,
          sqrtPriceLimitX96:
            sqrtPriceLimitX96 ?? tokenIn.toLowerCase() < tokenOut.toLowerCase()
              ? BigNumber.from('4295128740')
              : BigNumber.from('1461446703485210103287273052203988822378723970341'),
          recipient: outputIsWSEI ? constants.AddressZero : trader.address,
          deadline: 1,
          amountIn,
          amountOutMinimum,
        }

        const data = [router.interface.encodeFunctionData('exactInputSingle', [params])]
        if (outputIsWSEI)
          data.push(router.interface.encodeFunctionData('unwrapWSEI', [amountOutMinimum, trader.address]))

        // ensure that the swap fails if the limit is any tighter
        params.amountOutMinimum += 1
        await expect(router.connect(trader).exactInputSingle(params, { value })).to.be.revertedWith(
          'Too little received'
        )
        params.amountOutMinimum -= 1

        // optimized for the gas test
        return data.length === 1
          ? router.connect(trader).exactInputSingle(params, { value })
          : router.connect(trader).multicall(data, { value })
      }

      it('0 -> 1', async () => {
        const pool = await factory.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM)

        // get balances before
        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(trader.address)

        await exactInputSingle(tokens[0].address, tokens[1].address)

        // get balances after
        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(trader.address)

        expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(3))
        expect(traderAfter.token1).to.be.eq(traderBefore.token1.add(1))
        expect(poolAfter.token0).to.be.eq(poolBefore.token0.add(3))
        expect(poolAfter.token1).to.be.eq(poolBefore.token1.sub(1))
      })

      it('1 -> 0', async () => {
        const pool = await factory.getPool(tokens[1].address, tokens[0].address, FeeAmount.MEDIUM)

        // get balances before
        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(trader.address)

        await exactInputSingle(tokens[1].address, tokens[0].address)

        // get balances after
        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(trader.address)

        expect(traderAfter.token0).to.be.eq(traderBefore.token0.add(1))
        expect(traderAfter.token1).to.be.eq(traderBefore.token1.sub(3))
        expect(poolAfter.token0).to.be.eq(poolBefore.token0.sub(1))
        expect(poolAfter.token1).to.be.eq(poolBefore.token1.add(3))
      })

      describe('SEI input', () => {
        describe('WSEI', () => {
          beforeEach(async () => {
            await createPoolWSEI(tokens[0].address)
          })

          it('WSEI -> 0', async () => {
            const pool = await factory.getPool(wsei.address, tokens[0].address, FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactInputSingle(wsei.address, tokens[0].address))
              .to.emit(wsei, 'Deposit')
              .withArgs(router.address, 3)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0.add(1))
            expect(poolAfter.wsei).to.be.eq(poolBefore.wsei.add(3))
            expect(poolAfter.token0).to.be.eq(poolBefore.token0.sub(1))
          })
        })
      })

      describe('SEI output', () => {
        describe('WSEI', () => {
          beforeEach(async () => {
            await createPoolWSEI(tokens[0].address)
            await createPoolWSEI(tokens[1].address)
          })

          it('0 -> WSEI', async () => {
            const pool = await factory.getPool(tokens[0].address, wsei.address, FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactInputSingle(tokens[0].address, wsei.address))
              .to.emit(wsei, 'Withdrawal')
              .withArgs(router.address, 1)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(3))
            expect(poolAfter.wsei).to.be.eq(poolBefore.wsei.sub(1))
            expect(poolAfter.token0).to.be.eq(poolBefore.token0.add(3))
          })
        })
      })
    })

    describe('#exactOutput', () => {
      async function exactOutput(
        tokens: string[],
        amountOut: number = 1,
        amountInMaximum: number = 3
      ): Promise<ContractTransaction> {
        const inputIsWSEI = tokens[0] === wsei.address
        const outputIsWSEI = tokens[tokens.length - 1] === wsei.address

        const value = inputIsWSEI ? amountInMaximum : 0

        const params = {
          path: encodePath(tokens.slice().reverse(), new Array(tokens.length - 1).fill(FeeAmount.MEDIUM)),
          recipient: outputIsWSEI ? constants.AddressZero : trader.address,
          deadline: 1,
          amountOut,
          amountInMaximum,
        }

        const data = [router.interface.encodeFunctionData('exactOutput', [params])]
        if (inputIsWSEI) data.push(router.interface.encodeFunctionData('unwrapWSEI', [0, trader.address]))
        if (outputIsWSEI) data.push(router.interface.encodeFunctionData('unwrapWSEI', [amountOut, trader.address]))

        // ensure that the swap fails if the limit is any tighter
        params.amountInMaximum -= 1
        await expect(router.connect(trader).exactOutput(params, { value })).to.be.revertedWith('Too much requested')
        params.amountInMaximum += 1

        return router.connect(trader).multicall(data, { value })
      }

      describe('single-pool', () => {
        it('0 -> 1', async () => {
          const pool = await factory.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM)

          // get balances before
          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(trader.address)

          await exactOutput(tokens.slice(0, 2).map((token) => token.address))

          // get balances after
          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(3))
          expect(traderAfter.token1).to.be.eq(traderBefore.token1.add(1))
          expect(poolAfter.token0).to.be.eq(poolBefore.token0.add(3))
          expect(poolAfter.token1).to.be.eq(poolBefore.token1.sub(1))
        })

        it('1 -> 0', async () => {
          const pool = await factory.getPool(tokens[1].address, tokens[0].address, FeeAmount.MEDIUM)

          // get balances before
          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(trader.address)

          await exactOutput(
            tokens
              .slice(0, 2)
              .reverse()
              .map((token) => token.address)
          )

          // get balances after
          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0.add(1))
          expect(traderAfter.token1).to.be.eq(traderBefore.token1.sub(3))
          expect(poolAfter.token0).to.be.eq(poolBefore.token0.sub(1))
          expect(poolAfter.token1).to.be.eq(poolBefore.token1.add(3))
        })
      })

      describe('multi-pool', () => {
        it('0 -> 1 -> 2', async () => {
          const traderBefore = await getBalances(trader.address)

          await exactOutput(
            tokens.map((token) => token.address),
            1,
            5
          )

          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(5))
          expect(traderAfter.token2).to.be.eq(traderBefore.token2.add(1))
        })

        it('2 -> 1 -> 0', async () => {
          const traderBefore = await getBalances(trader.address)

          await exactOutput(tokens.map((token) => token.address).reverse(), 1, 5)

          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token2).to.be.eq(traderBefore.token2.sub(5))
          expect(traderAfter.token0).to.be.eq(traderBefore.token0.add(1))
        })

        it('events', async () => {
          await expect(
            exactOutput(
              tokens.map((token) => token.address),
              1,
              5
            )
          )
            .to.emit(tokens[2], 'Transfer')
            .withArgs(
              computePoolAddress(factory.address, [tokens[2].address, tokens[1].address], FeeAmount.MEDIUM),
              trader.address,
              1
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              computePoolAddress(factory.address, [tokens[1].address, tokens[0].address], FeeAmount.MEDIUM),
              computePoolAddress(factory.address, [tokens[2].address, tokens[1].address], FeeAmount.MEDIUM),
              3
            )
            .to.emit(tokens[0], 'Transfer')
            .withArgs(
              trader.address,
              computePoolAddress(factory.address, [tokens[1].address, tokens[0].address], FeeAmount.MEDIUM),
              5
            )
        })
      })

      describe('SEI input', () => {
        describe('WSEI', () => {
          beforeEach(async () => {
            await createPoolWSEI(tokens[0].address)
          })

          it('WSEI -> 0', async () => {
            const pool = await factory.getPool(wsei.address, tokens[0].address, FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutput([wsei.address, tokens[0].address]))
              .to.emit(wsei, 'Deposit')
              .withArgs(router.address, 3)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0.add(1))
            expect(poolAfter.wsei).to.be.eq(poolBefore.wsei.add(3))
            expect(poolAfter.token0).to.be.eq(poolBefore.token0.sub(1))
          })

          it('WSEI -> 0 -> 1', async () => {
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutput([wsei.address, tokens[0].address, tokens[1].address], 1, 5))
              .to.emit(wsei, 'Deposit')
              .withArgs(router.address, 5)

            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token1).to.be.eq(traderBefore.token1.add(1))
          })
        })
      })

      describe('SEI output', () => {
        describe('WSEI', () => {
          beforeEach(async () => {
            await createPoolWSEI(tokens[0].address)
            await createPoolWSEI(tokens[1].address)
          })

          it('0 -> WSEI', async () => {
            const pool = await factory.getPool(tokens[0].address, wsei.address, FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutput([tokens[0].address, wsei.address]))
              .to.emit(wsei, 'Withdrawal')
              .withArgs(router.address, 1)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(3))
            expect(poolAfter.wsei).to.be.eq(poolBefore.wsei.sub(1))
            expect(poolAfter.token0).to.be.eq(poolBefore.token0.add(3))
          })

          it('0 -> 1 -> WSEI', async () => {
            // get balances before
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutput([tokens[0].address, tokens[1].address, wsei.address], 1, 5))
              .to.emit(wsei, 'Withdrawal')
              .withArgs(router.address, 1)

            // get balances after
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(5))
          })
        })
      })
    })

    describe('#exactOutputSingle', () => {
      async function exactOutputSingle(
        tokenIn: string,
        tokenOut: string,
        amountOut: number = 1,
        amountInMaximum: number = 3,
        sqrtPriceLimitX96?: BigNumber
      ): Promise<ContractTransaction> {
        const inputIsWSEI = tokenIn === wsei.address
        const outputIsWSEI = tokenOut === wsei.address

        const value = inputIsWSEI ? amountInMaximum : 0

        const params = {
          tokenIn,
          tokenOut,
          fee: FeeAmount.MEDIUM,
          recipient: outputIsWSEI ? constants.AddressZero : trader.address,
          deadline: 1,
          amountOut,
          amountInMaximum,
          sqrtPriceLimitX96:
            sqrtPriceLimitX96 ?? tokenIn.toLowerCase() < tokenOut.toLowerCase()
              ? BigNumber.from('4295128740')
              : BigNumber.from('1461446703485210103287273052203988822378723970341'),
        }

        const data = [router.interface.encodeFunctionData('exactOutputSingle', [params])]
        if (inputIsWSEI) data.push(router.interface.encodeFunctionData('refundSEI'))
        if (outputIsWSEI) data.push(router.interface.encodeFunctionData('unwrapWSEI', [amountOut, trader.address]))

        // ensure that the swap fails if the limit is any tighter
        params.amountInMaximum -= 1
        await expect(router.connect(trader).exactOutputSingle(params, { value })).to.be.revertedWith(
          'Too much requested'
        )
        params.amountInMaximum += 1

        return router.connect(trader).multicall(data, { value })
      }

      it('0 -> 1', async () => {
        const pool = await factory.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM)

        // get balances before
        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(trader.address)

        await exactOutputSingle(tokens[0].address, tokens[1].address)

        // get balances after
        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(trader.address)

        expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(3))
        expect(traderAfter.token1).to.be.eq(traderBefore.token1.add(1))
        expect(poolAfter.token0).to.be.eq(poolBefore.token0.add(3))
        expect(poolAfter.token1).to.be.eq(poolBefore.token1.sub(1))
      })

      it('1 -> 0', async () => {
        const pool = await factory.getPool(tokens[1].address, tokens[0].address, FeeAmount.MEDIUM)

        // get balances before
        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(trader.address)

        await exactOutputSingle(tokens[1].address, tokens[0].address)

        // get balances after
        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(trader.address)

        expect(traderAfter.token0).to.be.eq(traderBefore.token0.add(1))
        expect(traderAfter.token1).to.be.eq(traderBefore.token1.sub(3))
        expect(poolAfter.token0).to.be.eq(poolBefore.token0.sub(1))
        expect(poolAfter.token1).to.be.eq(poolBefore.token1.add(3))
      })

      describe('SEI input', () => {
        describe('WSEI', () => {
          beforeEach(async () => {
            await createPoolWSEI(tokens[0].address)
          })

          it('WSEI -> 0', async () => {
            const pool = await factory.getPool(wsei.address, tokens[0].address, FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutputSingle(wsei.address, tokens[0].address))
              .to.emit(wsei, 'Deposit')
              .withArgs(router.address, 3)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0.add(1))
            expect(poolAfter.wsei).to.be.eq(poolBefore.wsei.add(3))
            expect(poolAfter.token0).to.be.eq(poolBefore.token0.sub(1))
          })
        })
      })

      describe('SEI output', () => {
        describe('WSEI', () => {
          beforeEach(async () => {
            await createPoolWSEI(tokens[0].address)
            await createPoolWSEI(tokens[1].address)
          })

          it('0 -> WSEI', async () => {
            const pool = await factory.getPool(tokens[0].address, wsei.address, FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutputSingle(tokens[0].address, wsei.address))
              .to.emit(wsei, 'Withdrawal')
              .withArgs(router.address, 1)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0.sub(3))
            expect(poolAfter.wsei).to.be.eq(poolBefore.wsei.sub(1))
            expect(poolAfter.token0).to.be.eq(poolBefore.token0.add(3))
          })
        })
      })
    })

    describe('*WithFee', () => {
      const feeRecipient = '0xfEE0000000000000000000000000000000000000'

      it('#sweepTokenWithFee', async () => {
        const amountOutMinimum = 100
        const params = {
          path: encodePath([tokens[0].address, tokens[1].address], [FeeAmount.MEDIUM]),
          recipient: router.address,
          deadline: 1,
          amountIn: 102,
          amountOutMinimum,
        }

        const data = [
          router.interface.encodeFunctionData('exactInput', [params]),
          router.interface.encodeFunctionData('sweepTokenWithFee', [
            tokens[1].address,
            amountOutMinimum,
            trader.address,
            100,
            feeRecipient,
          ]),
        ]

        await router.connect(trader).multicall(data)

        const balance = await tokens[1].balanceOf(feeRecipient)
        expect(balance.eq(1)).to.be.eq(true)
      })

      it('#unwrapWSEIWithFee', async () => {
        const startBalance = await waffle.provider.getBalance(feeRecipient)
        await createPoolWSEI(tokens[0].address)

        const amountOutMinimum = 100
        const params = {
          path: encodePath([tokens[0].address, wsei.address], [FeeAmount.MEDIUM]),
          recipient: router.address,
          deadline: 1,
          amountIn: 102,
          amountOutMinimum,
        }

        const data = [
          router.interface.encodeFunctionData('exactInput', [params]),
          router.interface.encodeFunctionData('unwrapWSEIWithFee', [
            amountOutMinimum,
            trader.address,
            100,
            feeRecipient,
          ]),
        ]

        await router.connect(trader).multicall(data)
        const endBalance = await waffle.provider.getBalance(feeRecipient)
        expect(endBalance.sub(startBalance).eq(1)).to.be.eq(true)
      })
    })
  })
})
