// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '@dragonswap/v2-core/contracts/interfaces/IDragonswapV2Factory.sol';
import '@dragonswap/v2-core/contracts/interfaces/IDragonswapV2Pool.sol';

import './PeripheryImmutableState.sol';
import '../interfaces/IPoolInitializer.sol';

/// @title Creates and initializes v2 Pools
abstract contract PoolInitializer is IPoolInitializer, PeripheryImmutableState {
    /// @inheritdoc IPoolInitializer
    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable override returns (address pool) {
        require(token0 < token1);
        pool = IDragonswapV2Factory(factory).getPool(token0, token1, fee);

        if (pool == address(0)) {
            pool = IDragonswapV2Factory(factory).createPool(token0, token1, fee);
            IDragonswapV2Pool(pool).initialize(sqrtPriceX96);
        } else {
            (uint160 sqrtPriceX96Existing, , , , , , ) = IDragonswapV2Pool(pool).slot0();
            if (sqrtPriceX96Existing == 0) {
                IDragonswapV2Pool(pool).initialize(sqrtPriceX96);
            }
        }
    }
}
