// Base Mainnet (8453) hoặc Base Sepolia (84532)
export const TOKENCAST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`; // Sẽ thay bằng địa chỉ contract sau khi deploy

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
