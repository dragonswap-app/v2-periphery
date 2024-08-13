# Dragonswap v2 Periphery

[![Tests](https://github.com/dragonswap-app/v2-periphery/workflows/Tests/badge.svg)](https://github.com/dragonswap-app/v2-periphery/actions?query=workflow%3ATests)
[![Lint](https://github.com/dragonswap-app/v2-periphery/workflows/Lint/badge.svg)](https://github.com/dragonswap-app/v2-periphery/actions?query=workflow%3ALint)

This repository contains the periphery smart contracts for the Dragonswap V2 Protocol.
For the lower level core contracts, see the [dragonswap-v2-core](https://github.com/Dragonswap/dragonswap-v2-core)
repository.

## Links

- [Audit report](https://github.com/dragonswap-app/v2-core/blob/main/audits/20240801_Paladin_DragonSwapDEX_Final_Report.pdf)

## Local deployment

In order to deploy this code to a local testnet, you should clone this repository and import bytecode imported from artifacts located at
`./artifacts/contracts/**/*.json`.
For example:

```typescript
import {
  abi as SWAP_ROUTER_ABI,
  bytecode as SWAP_ROUTER_BYTECODE,
} from './artifacts/contracts/SwapRouter.sol/SwapRouter.json'

// deploy the bytecode
```

This will ensure that you are testing against the same bytecode that is deployed to
mainnet and public testnets, and all Dragonswap code will correctly interoperate with
your local deployment.

## Using solidity interfaces

The Dragonswap V2 periphery interfaces are available for import into solidity smart contracts
via the npm artifact `@dragonswap/v2-periphery`, e.g.:

```solidity
import '@dragonswap/v2-periphery/contracts/interfaces/ISwapRouter.sol';

contract MyContract {
  ISwapRouter router;

  function doSomethingWithSwapRouter() {
    // router.exactInput(...);
  }
}

```
