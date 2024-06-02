import { abi as POOL_ABI } from '../contracts/DragonswapV2Pool.json'
import { Contract, Wallet } from 'ethers'
import { IDragonswapV2Pool } from '../../typechain'

export default function poolAtAddress(address: string, wallet: Wallet): IDragonswapV2Pool {
  return new Contract(address, POOL_ABI, wallet) as IDragonswapV2Pool
}
