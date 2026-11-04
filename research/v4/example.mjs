import { allocate } from "./allocation.mjs"

const result = allocate(10000n, 10000n, [
  { fid: 1, wallet: "0x0000000000000000000000000000000000000001", followers: 1000 },
  { fid: 2, wallet: "0x0000000000000000000000000000000000000002", followers: 2000 },
])
console.log(JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value, 2))
