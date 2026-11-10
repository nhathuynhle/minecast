// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INitroValidatorV4} from "../../../contracts/v4/MineCastNodeAttestationV4.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Test-only replacement for external Nitro cryptography. Never use for deployment.
contract TestNitroValidator is INitroValidatorV4 {
    address immutable issuer;
    error InvalidFixture();

    constructor(address issuer_) { issuer = issuer_; }

    function validateAttestationWithHints(bytes calldata tbs, bytes calldata signature, bytes calldata)
        external view returns (Fields memory f)
    {
        if (tbs.length != 120 || ECDSA.recover(keccak256(tbs), signature) != issuer) revert InvalidFixture();
        f.moduleId = 0x60 | (88 << 80) | (32 << 160);
        f.timestamp = uint64(bytes8(tbs[:8]));
        f.pcrs = new uint256[](32);
        f.pcrs[0] = 0x40 | (8 << 80) | (48 << 160);
        f.userData = 0x40 | (56 << 80) | (32 << 160);
    }
}
