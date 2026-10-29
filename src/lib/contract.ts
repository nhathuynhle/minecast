import { isAddress, zeroAddress } from "viem"

// These values deliberately come from the deployment environment. Never ship a
// placeholder address as if it were a live token contract.
const configuredAddress = import.meta.env.VITE_TOKENCAST_CONTRACT_ADDRESS
export const TOKENCAST_CONTRACT_ADDRESS = (
  configuredAddress && isAddress(configuredAddress) ? configuredAddress : zeroAddress
) as `0x${string}`

const requestedChainId = Number(import.meta.env.VITE_TOKENCAST_CHAIN_ID ?? 8453)
export const TOKENCAST_CHAIN_ID = requestedChainId === 84532 ? 84532 : 8453
export const TOKENCAST_IS_DEPLOYED = TOKENCAST_CONTRACT_ADDRESS !== zeroAddress

export const TOKENCAST_ABI = [
  {
    type: "function",
    name: "claim",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "remainingSupply",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "userNonces",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "mintedSupply",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "currentEra",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view"
  }
] as const;
