// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Validates independently-produced Farcaster airdrop snapshots.
/// @dev The signer set is immutable: a compromised MineCast backend cannot replace it.
contract MineCastAirdropSnapshotAttestor is EIP712 {
    uint256 public constant SIGNER_COUNT = 5;
    uint256 public constant THRESHOLD = 3;
    bytes32 public constant AIRDROP_SNAPSHOT_TYPEHASH = keccak256(
        "AirdropSnapshot(uint256 epoch,bytes32 merkleRoot,bytes32 policyHash,bytes32 snapshotHash,uint256 amount,uint32 claimDuration)"
    );

    address[SIGNER_COUNT] public signers;
    mapping(address signer => bool) public isSigner;

    error InvalidSignerSet();
    error InvalidSignatureCount();
    error UnauthorizedSigner(address signer);
    error DuplicateSigner(address signer);

    constructor(address[SIGNER_COUNT] memory signerSet) EIP712("MineCast Airdrop Snapshot", "1") {
        for (uint256 i; i < SIGNER_COUNT; ++i) {
            address signer = signerSet[i];
            if (signer == address(0) || isSigner[signer]) revert InvalidSignerSet();
            signers[i] = signer;
            isSigner[signer] = true;
        }
    }

    /// @notice Returns the EIP-712 digest that every independent snapshot signer must approve.
    function snapshotDigest(
        uint256 epoch,
        bytes32 merkleRoot,
        bytes32 policyHash,
        bytes32 snapshotHash,
        uint256 amount,
        uint32 claimDuration
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(AIRDROP_SNAPSHOT_TYPEHASH, epoch, merkleRoot, policyHash, snapshotHash, amount, claimDuration))
        );
    }

    /// @notice Reverts unless three distinct members of the immutable five-wallet set signed this exact snapshot.
    function validateAirdrop(
        uint256 epoch,
        bytes32 merkleRoot,
        bytes32 policyHash,
        bytes32 snapshotHash,
        uint256 amount,
        uint32 claimDuration,
        bytes[] calldata signatures
    ) external view {
        if (signatures.length < THRESHOLD || signatures.length > SIGNER_COUNT) revert InvalidSignatureCount();

        bytes32 digest = snapshotDigest(epoch, merkleRoot, policyHash, snapshotHash, amount, claimDuration);
        address[] memory seen = new address[](signatures.length);
        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (!isSigner[signer]) revert UnauthorizedSigner(signer);
            for (uint256 j; j < i; ++j) {
                if (seen[j] == signer) revert DuplicateSigner(signer);
            }
            seen[i] = signer;
        }
    }
}
