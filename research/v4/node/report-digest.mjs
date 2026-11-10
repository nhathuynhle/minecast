import { encodeAbiParameters, keccak256, stringToHex } from 'viem'

const fields = ['uint256', 'address', 'bytes32', 'address', 'uint256', 'uint256',
  'uint256', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32'].map(type => ({ type }))

// Only call inside the measured reporter after deriving and publishing the snapshot.
export function reportDigest({ chainId, distributor, policyHash, reporter, day, cutoff, nonce,
  root, allocated, dataHash, dataURI, rosterHash }) {
  return keccak256(encodeAbiParameters(fields, [chainId, distributor, policyHash, reporter,
    day, cutoff, nonce, root, allocated, dataHash, keccak256(stringToHex(dataURI)), rosterHash]))
}
