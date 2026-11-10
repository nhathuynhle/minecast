// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {MineCastCalendar} from "../v3/MineCastCalendar.sol";
import {MineCastMiningOracleV4} from "./MineCastMiningOracleV4.sol";
import {INitroValidatorV4} from "./MineCastNodeAttestationV4.sol";
import {MineCastMonthlyDaoV4} from "./MineCastMonthlyDaoV4.sol";
import {MineCastStakingV4} from "./MineCastStakingV4.sol";
import {TokenCastV4} from "./TokenCastV4.sol";

contract MineCastDailyDistributorV4 is MineCastMiningOracleV4 {
    uint256 public constant MAX_MINER_BPS = 100;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant CLAIM_WINDOW = 1 days;

    MineCastMonthlyDaoV4 public immutable treasury;
    mapping(uint256 day => bytes32) public dayRoot;
    mapping(uint256 day => uint256) public allocatedForDay;
    mapping(uint256 day => uint256) public claimedForDay;
    mapping(uint256 month => bool) public monthFinalized;
    mapping(uint256 day => uint256) public claimEnd;
    mapping(uint256 month => uint256) public totalClaimedByMonth;
    mapping(uint256 month => mapping(address wallet => uint256)) public claimedByMonth;
    mapping(uint256 day => mapping(uint256 fid => bool)) public claimedFid;
    mapping(uint256 day => mapping(address wallet => bool)) public claimedWallet;

    error MonthNotReady();
    error InvalidClaim();
    error AlreadyClaimed();

    event DayActivated(uint256 indexed day, bytes32 root, uint256 allocated, uint256 claimEnd);
    event Claimed(uint256 indexed day, uint256 indexed fid, address indexed wallet, uint256 amount);

    event SurplusFunded(uint256 indexed day, uint256 stakingAmount, uint256 treasuryAmount);
    event MonthFinalized(uint256 indexed month, uint256 totalMined);

    constructor(TokenCastV4 token_, MineCastStakingV4 staking_, MineCastMonthlyDaoV4 treasury_,
        uint256 ethBond_, bytes32 policyHash_, INitroValidatorV4 validator_, bytes memory pcr0)
        MineCastMiningOracleV4(token_, staking_, ethBond_, policyHash_, validator_, pcr0)
    {
        if (address(treasury_.token()) != address(token_) || address(treasury_.staking()) != address(staking_)) {
            revert InvalidConfiguration();
        }
        treasury = treasury_;
    }

    function _activate(uint256 day, bytes32 root, uint256 allocated) internal override {
        dayRoot[day] = root;
        allocatedForDay[day] = allocated;
        claimEnd[day] = block.timestamp + CLAIM_WINDOW;
        uint256 surplus = token.dailyEmissionForDay(day) - allocated;
        uint256 stakingAmount = surplus * 5 / 100;
        uint256 treasuryAmount = surplus - stakingAmount;
        if (stakingAmount != 0) {
            token.issue(day, address(this), stakingAmount);
            token.approve(address(staking), stakingAmount);
            staking.fundFutureRewards(stakingAmount);
        }
        if (treasuryAmount != 0) token.issue(day, address(treasury), treasuryAmount);
        emit SurplusFunded(day, stakingAmount, treasuryAmount);
        emit DayActivated(day, root, allocated, claimEnd[day]);
    }

    /// @param nextMonthStart UTC midnight on the first day of the following month.
    /// @dev Even the last possible mining day has ended, timed out and exhausted its 24h claim window.
    function finalizeMonth(uint256 nextMonthStart) external {
        if (nextMonthStart == 0 || nextMonthStart > block.timestamp || nextMonthStart % 1 days != 0
            || block.timestamp < nextMonthStart + 1 days + RESULT_WINDOW + CLAIM_WINDOW) revert MonthNotReady();
        (,, uint256 date) = MineCastCalendar.yearMonthDay(nextMonthStart);
        (uint256 year, uint256 month,) = MineCastCalendar.yearMonthDay(nextMonthStart - 1);
        uint256 id = year * 100 + month;
        if (date != 1 || nextMonthStart <= token.launchTime() || monthFinalized[id]) revert MonthNotReady();
        monthFinalized[id] = true;
        emit MonthFinalized(id, totalClaimedByMonth[id]);
    }

    /// @notice The allocation belongs to the caller's wallet; no delegated claim.
    /// @dev A proof establishes membership, not FID ownership or correct weight.
    ///      Chain and contract bindings prevent reuse against another deployment.
    function claim(uint256 day, uint256 fid, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        if (!dayActivated[day] || block.timestamp >= claimEnd[day] || fid == 0 || amount == 0 || amount > token.dailyEmissionForDay(day) * MAX_MINER_BPS / BPS_DENOMINATOR) revert InvalidClaim();
        if (claimedFid[day][fid] || claimedWallet[day][msg.sender]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), day, fid, msg.sender, amount))));
        if (!MerkleProof.verifyCalldata(proof, dayRoot[day], leaf)) revert InvalidClaim();
        uint256 newTotal = claimedForDay[day] + amount;
        if (newTotal > allocatedForDay[day]) revert InvalidClaim();
        claimedFid[day][fid] = true;
        claimedWallet[day][msg.sender] = true;
        claimedForDay[day] = newTotal;
        (uint256 year, uint256 month,) = MineCastCalendar.yearMonthDay(uint256(token.launchTime()) + day * 1 days);
        uint256 monthId = year * 100 + month;
        if (monthFinalized[monthId]) revert InvalidClaim();
        totalClaimedByMonth[monthId] += amount;
        claimedByMonth[monthId][msg.sender] += amount;
        token.issue(day, msg.sender, amount);
        emit Claimed(day, fid, msg.sender, amount);
    }
}
