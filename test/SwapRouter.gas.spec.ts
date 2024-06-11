import { abi as DragonswapV2PoolABI } from './contracts/DragonswapV2Pool.json'
import { Fixture } from 'ethereum-waffle'
import { BigNumber, constants, ContractTransaction, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { IDragonswapV2Pool, IWSEI, MockTimeSwapRouter, TestERC20 } from '../typechain'
import completeFixture from './shared/completeFixture'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { expect } from './shared/expect'
import { encodePath } from './shared/path'
import snapshotGasCost from './shared/snapshotGasCost'
import { getMaxTick, getMinTick } from './shared/ticks'

describe('SwapRouter gas tests', function () {
  this.timeout(40000)
  let wallet: Wallet
  let trader: Wallet

  const swapRouterFixture: Fixture<{
    wsei: IWSEI
    router: MockTimeSwapRouter
    tokens: [TestERC20, TestERC20, TestERC20]
    pools: [IDragonswapV2Pool, IDragonswapV2Pool, IDragonswapV2Pool]
  }> = async (wallets, provider) => {
    const { wsei, factory, router, tokens, nft } = await completeFixture(wallets, provider)

    // approve & fund wallets
    for (const token of tokens) {
      await token.approve(router.address, constants.MaxUint256)
      await token.approve(nft.address, constants.MaxUint256)
      await token.connect(trader).approve(router.address, constants.MaxUint256)
      await token.transfer(trader.address, expandTo18Decimals(1_000_000))
    }

    const liquidity = 1000000
    async function createPool(tokenAddressA: string, tokenAddressB: string) {
      if (tokenAddressA.toLowerCase() > tokenAddressB.toLowerCase())
        [tokenAddressA, tokenAddressB] = [tokenAddressB, tokenAddressA]

      await nft.createAndInitializePoolIfNecessary(
        tokenAddressA,
        tokenAddressB,
        FeeAmount.MEDIUM,
        encodePriceSqrt(100005, 100000) // we don't want to cross any ticks
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
      await wsei.deposit({ value: liquidity * 2 })
      await wsei.approve(nft.address, constants.MaxUint256)
      return createPool(wsei.address, tokenAddress)
    }

    // create pools
    await createPool(tokens[0].address, tokens[1].address)
    await createPool(tokens[1].address, tokens[2].address)
    await createPoolWSEI(tokens[0].address)

    const poolAddresses = await Promise.all([
      factory.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM),
      factory.getPool(tokens[1].address, tokens[2].address, FeeAmount.MEDIUM),
      factory.getPool(wsei.address, tokens[0].address, FeeAmount.MEDIUM),
    ])

    const pools = poolAddresses.map((poolAddress) => new ethers.Contract(poolAddress, DragonswapV2PoolABI, wallet)) as [
      IDragonswapV2Pool,
      IDragonswapV2Pool,
      IDragonswapV2Pool
    ]

    return {
      wsei,
      router,
      tokens,
      pools,
    }
  }

  let wsei: IWSEI
  let router: MockTimeSwapRouter
  let tokens: [TestERC20, TestERC20, TestERC20]
  let pools: [IDragonswapV2Pool, IDragonswapV2Pool, IDragonswapV2Pool]

  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    const wallets = await (ethers as any).getSigners()
    ;[wallet, trader] = wallets

    loadFixture = waffle.createFixtureLoader(wallets)
  })

  beforeEach('load fixture', async () => {
    ;({ router, wsei, tokens, pools } = await loadFixture(swapRouterFixture))
  })

  async function exactInput(
    tokens: string[],
    amountIn: number = 2,
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
      amountOutMinimum: outputIsWSEI ? 0 : amountOutMinimum, // save on calldata,
    }

    const data = [router.interface.encodeFunctionData('exactInput', [params])]
    if (outputIsWSEI) data.push(router.interface.encodeFunctionData('unwrapWSEI', [amountOutMinimum, trader.address]))

    // optimized for the gas test
    return data.length === 1
      ? router.connect(trader).exactInput(params, { value })
      : router.connect(trader).multicall(data, { value })
  }

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
      sqrtPriceLimitX96: sqrtPriceLimitX96 ?? 0,
      recipient: outputIsWSEI ? constants.AddressZero : trader.address,
      deadline: 1,
      amountIn,
      amountOutMinimum: outputIsWSEI ? 0 : amountOutMinimum, // save on calldata
    }

    const data = [router.interface.encodeFunctionData('exactInputSingle', [params])]
    if (outputIsWSEI) data.push(router.interface.encodeFunctionData('unwrapWSEI', [amountOutMinimum, trader.address]))

    // optimized for the gas test
    return data.length === 1
      ? router.connect(trader).exactInputSingle(params, { value })
      : router.connect(trader).multicall(data, { value })
  }

  async function exactOutput(tokens: string[]): Promise<ContractTransaction> {
    const amountInMaximum = 10 // we don't care
    const amountOut = 1

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
    if (inputIsWSEI) data.push(router.interface.encodeFunctionData('refundSEI'))
    if (outputIsWSEI) data.push(router.interface.encodeFunctionData('unwrapWSEI', [amountOut, trader.address]))

    return router.connect(trader).multicall(data, { value })
  }

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
      sqrtPriceLimitX96: sqrtPriceLimitX96 ?? 0,
    }

    const data = [router.interface.encodeFunctionData('exactOutputSingle', [params])]
    if (inputIsWSEI) data.push(router.interface.encodeFunctionData('unwrapWSEI', [0, trader.address]))
    if (outputIsWSEI) data.push(router.interface.encodeFunctionData('unwrapWSEI', [amountOut, trader.address]))

    return router.connect(trader).multicall(data, { value })
  }

  // TODO should really throw this in the fixture
  beforeEach('intialize feeGrowthGlobals', async () => {
    await exactInput([tokens[0].address, tokens[1].address], 1, 0)
    await exactInput([tokens[1].address, tokens[0].address], 1, 0)
    await exactInput([tokens[1].address, tokens[2].address], 1, 0)
    await exactInput([tokens[2].address, tokens[1].address], 1, 0)
    await exactInput([tokens[0].address, wsei.address], 1, 0)
    await exactInput([wsei.address, tokens[0].address], 1, 0)
  })

  beforeEach('ensure feeGrowthGlobals are >0', async () => {
    const slots = await Promise.all(
      pools.map((pool) =>
        Promise.all([
          pool.feeGrowthGlobal0X128().then((f) => f.toString()),
          pool.feeGrowthGlobal1X128().then((f) => f.toString()),
        ])
      )
    )

    expect(slots).to.deep.eq([
      ['340290874192793283295456993856614', '340290874192793283295456993856614'],
      ['340290874192793283295456993856614', '340290874192793283295456993856614'],
      ['340290874192793283295456993856614', '340290874192793283295456993856614'],
    ])
  })

  beforeEach('ensure ticks are 0 before', async () => {
    const slots = await Promise.all(pools.map((pool) => pool.slot0().then(({ tick }) => tick)))
    expect(slots).to.deep.eq([0, 0, 0])
  })

  afterEach('ensure ticks are 0 after', async () => {
    const slots = await Promise.all(pools.map((pool) => pool.slot0().then(({ tick }) => tick)))
    expect(slots).to.deep.eq([0, 0, 0])
  })

  describe('#exactInput', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactInput(tokens.slice(0, 2).map((token) => token.address)))
    })

    it('0 -> 1 minimal', async () => {
      const calleeFactory = await ethers.getContractFactory('TestDragonswapV2Callee')
      const callee = await calleeFactory.deploy()

      await tokens[0].connect(trader).approve(callee.address, constants.MaxUint256)
      await snapshotGasCost(callee.connect(trader).swapExact0For1(pools[0].address, 2, trader.address, '4295128740'))
    })

    it('0 -> 1 -> 2', async () => {
      await snapshotGasCost(
        exactInput(
          tokens.map((token) => token.address),
          3
        )
      )
    })

    it('WSEI -> 0', async () => {
      await snapshotGasCost(
        exactInput(
          [wsei.address, tokens[0].address],
          wsei.address.toLowerCase() < tokens[0].address.toLowerCase() ? 2 : 3
        )
      )
    })

    it('0 -> WSEI', async () => {
      await snapshotGasCost(
        exactInput(
          [tokens[0].address, wsei.address],
          tokens[0].address.toLowerCase() < wsei.address.toLowerCase() ? 2 : 3
        )
      )
    })

    it('2 trades (via router)', async () => {
      await wsei.connect(trader).deposit({ value: 3 })
      await wsei.connect(trader).approve(router.address, constants.MaxUint256)
      const swap0 = {
        path: encodePath([wsei.address, tokens[0].address], [FeeAmount.MEDIUM]),
        recipient: constants.AddressZero,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 0, // save on calldata
      }

      const swap1 = {
        path: encodePath([tokens[1].address, tokens[0].address], [FeeAmount.MEDIUM]),
        recipient: constants.AddressZero,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 0, // save on calldata
      }

      const data = [
        router.interface.encodeFunctionData('exactInput', [swap0]),
        router.interface.encodeFunctionData('exactInput', [swap1]),
        router.interface.encodeFunctionData('sweepToken', [tokens[0].address, 2, trader.address]),
      ]

      await snapshotGasCost(router.connect(trader).multicall(data))
    })

    it('3 trades (directly to sender)', async () => {
      await wsei.connect(trader).deposit({ value: 3 })
      await wsei.connect(trader).approve(router.address, constants.MaxUint256)
      const swap0 = {
        path: encodePath([wsei.address, tokens[0].address], [FeeAmount.MEDIUM]),
        recipient: trader.address,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 1,
      }

      const swap1 = {
        path: encodePath([tokens[0].address, tokens[1].address], [FeeAmount.MEDIUM]),
        recipient: trader.address,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 1,
      }

      const swap2 = {
        path: encodePath([tokens[1].address, tokens[2].address], [FeeAmount.MEDIUM]),
        recipient: trader.address,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 1,
      }

      const data = [
        router.interface.encodeFunctionData('exactInput', [swap0]),
        router.interface.encodeFunctionData('exactInput', [swap1]),
        router.interface.encodeFunctionData('exactInput', [swap2]),
      ]

      await snapshotGasCost(router.connect(trader).multicall(data))
    })
  })

  it('3 trades (directly to sender)', async () => {
    await wsei.connect(trader).deposit({ value: 3 })
    await wsei.connect(trader).approve(router.address, constants.MaxUint256)
    const swap0 = {
      path: encodePath([wsei.address, tokens[0].address], [FeeAmount.MEDIUM]),
      recipient: trader.address,
      deadline: 1,
      amountIn: 3,
      amountOutMinimum: 1,
    }

    const swap1 = {
      path: encodePath([tokens[1].address, tokens[0].address], [FeeAmount.MEDIUM]),
      recipient: trader.address,
      deadline: 1,
      amountIn: 3,
      amountOutMinimum: 1,
    }

    const data = [
      router.interface.encodeFunctionData('exactInput', [swap0]),
      router.interface.encodeFunctionData('exactInput', [swap1]),
    ]

    await snapshotGasCost(router.connect(trader).multicall(data))
  })

  describe('#exactInputSingle', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactInputSingle(tokens[0].address, tokens[1].address))
    })

    it('WSEI -> 0', async () => {
      await snapshotGasCost(
        exactInputSingle(
          wsei.address,
          tokens[0].address,
          wsei.address.toLowerCase() < tokens[0].address.toLowerCase() ? 2 : 3
        )
      )
    })

    it('0 -> WSEI', async () => {
      await snapshotGasCost(
        exactInputSingle(
          tokens[0].address,
          wsei.address,
          tokens[0].address.toLowerCase() < wsei.address.toLowerCase() ? 2 : 3
        )
      )
    })
  })

  describe('#exactOutput', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactOutput(tokens.slice(0, 2).map((token) => token.address)))
    })

    it('0 -> 1 -> 2', async () => {
      await snapshotGasCost(exactOutput(tokens.map((token) => token.address)))
    })

    it('WSEI -> 0', async () => {
      await snapshotGasCost(exactOutput([wsei.address, tokens[0].address]))
    })

    it('0 -> WSEI', async () => {
      await snapshotGasCost(exactOutput([tokens[0].address, wsei.address]))
    })
  })

  describe('#exactOutputSingle', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactOutputSingle(tokens[0].address, tokens[1].address))
    })

    it('WSEI -> 0', async () => {
      await snapshotGasCost(exactOutputSingle(wsei.address, tokens[0].address))
    })

    it('0 -> WSEI', async () => {
      await snapshotGasCost(exactOutputSingle(tokens[0].address, wsei.address))
    })
  })
})
