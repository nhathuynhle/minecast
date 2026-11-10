// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev ABI of base/nitro-validator's hinted COSE verifier. Pointers refer to the authenticated TBS bytes.
interface INitroValidatorV4 {
    struct Fields {
        uint256 moduleId;
        uint64 timestamp;
        uint256 digest;
        uint256[] pcrs;
        uint256 cert;
        uint256[] cabundle;
        uint256 publicKey;
        uint256 userData;
        uint256 nonce;
    }

    function validateAttestationWithHints(bytes calldata tbs, bytes calldata signature, bytes calldata hints)
        external returns (Fields memory);
}

/// @notice Attests the output of each measured worker run. Anyone can operate the approved image.
abstract contract MineCastNodeAttestationV4 {
    struct NodeProof {
        bytes tbs;
        bytes signature;
        bytes hints;
    }

    INitroValidatorV4 public immutable nitroValidator;
    bytes32 public immutable imageHash;
    uint256 public constant MAX_ATTESTATION_AGE = 15 minutes;

    error InvalidNodePolicy();
    error InvalidNodeProof();

    constructor(INitroValidatorV4 validator_, bytes memory pcr0) {
        if (address(validator_).code.length == 0 || pcr0.length != 48
            || keccak256(pcr0) == keccak256(new bytes(48))) revert InvalidNodePolicy();
        nitroValidator = validator_;
        imageHash = keccak256(pcr0);
    }

    function _verifyNode(NodeProof calldata proof, bytes32 expected, uint256 cutoff)
        internal returns (INitroValidatorV4.Fields memory fields) {
        fields = nitroValidator.validateAttestationWithHints(proof.tbs, proof.signature, proof.hints);
        uint256 issuedAt = fields.timestamp / 1000; // Nitro uses milliseconds.
        if (issuedAt < cutoff || issuedAt > block.timestamp || block.timestamp - issuedAt > MAX_ATTESTATION_AGE
            || fields.pcrs.length != 32) revert InvalidNodeProof();
        if (keccak256(_byteString(proof.tbs, fields.pcrs[0], 48)) != imageHash
            || bytes32(_byteString(proof.tbs, fields.userData, 32)) != expected) revert InvalidNodeProof();
    }

    function _moduleHash(bytes calldata tbs, uint256 ptr) internal pure returns (bytes32) {
        // Nitro module_id is an authenticated CBOR text string.
        uint256 offset = uint80(ptr >> 80);
        uint256 size = uint64(ptr >> 160);
        if (uint8(ptr) != 0x60 || size == 0 || offset + size > tbs.length) revert InvalidNodeProof();
        return keccak256(tbs[offset:offset + size]);
    }

    function _byteString(bytes calldata tbs, uint256 ptr, uint256 size) private pure returns (bytes calldata) {
        // LibCborElement packs its CBOR major type, byte offset and content length into one word.
        uint256 offset = uint80(ptr >> 80);
        if (uint8(ptr) != 0x40 || uint64(ptr >> 160) != size || offset + size > tbs.length) {
            revert InvalidNodeProof();
        }
        return tbs[offset:offset + size];
    }
}
