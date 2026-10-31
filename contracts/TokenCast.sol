// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MineCast — $TOKENCAST on Base
 * @notice Total Supply: 21,000,000,000 TOKENCAST (21 Billion)
 *         Chain: Base (ChainId 8453)
 */

abstract contract ERC20Base {
    string public name = "TokenCast";
    string public symbol = "TOKENCAST";
    uint8  public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function transfer(address to, uint256 amount) public returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ERC20: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(from != address(0) && to != address(0), "ERC20: zero address");
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to]   += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        require(to != address(0), "ERC20: mint to zero");
        totalSupply   += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}

contract TokenCast is ERC20Base {
    uint256 public constant MAX_SUPPLY = 21_000_000_000 * 1e18;
    // Bitcoin-like calendar schedule: Era 0 lasts 272 days, then emission halves.
    // With 100,000 daily miners this starts at ~386.0294 TOKENCAST per miner/day,
    // reaching ~99% planned issuance in roughly five years.
    uint256 public constant HALVING_PERIOD = 272 days;
    uint256 public constant TARGET_DAILY_MINERS = 100_000;
    uint256 public constant MAX_FOLLOWER_MULTIPLIER = 100;
    // Cast the numerator to uint256 before division so Solidity floors to wei.
    uint256 public constant BASE_DAILY_EMISSION = (uint256(10_500_000_000) * 1e18) / 272;
    // UI estimate only. The backend divides the daily emission budget across
    // verified miners, so a surge in miners cannot accelerate the hard cap.
    uint256 public constant BASE_SESSION_REWARD = BASE_DAILY_EMISSION / TARGET_DAILY_MINERS;
    uint256 public constant MAX_ERA = 32;

    address public owner;
    address public signServer;
    address public immutable airdropTreasury;
    bool    public paused;

    uint256 public mintedSupply;
    uint256 public immutable launchTime;
    mapping(address => uint256) public userNonces;
    mapping(address => uint256) public totalClaimed;
    mapping(address => uint256) public lastClaimAt;
    mapping(uint256 => bool) public dailyPoolFinalized;

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "ClaimVoucher(address user,uint256 amount,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant FINALIZE_DAILY_POOL_TYPEHASH = keccak256(
        "FinalizeDailyPool(uint256 day,uint256 allocated,uint256 deadline)"
    );

    event Claimed(address indexed user, uint256 amount, uint256 newTotalClaimed);
    event DailyPoolFinalized(uint256 indexed day, uint256 allocatedToCommunity, uint256 sentToAirdropTreasury);
    event SignServerUpdated(address indexed oldServer, address indexed newServer);
    event Paused(bool paused);

    modifier onlyOwner() {
        require(msg.sender == owner, "TokenCast: not owner");
        _;
    }

    modifier notPaused() {
        require(!paused, "TokenCast: paused");
        _;
    }

    constructor(address _signServer, address _airdropTreasury) {
        require(_signServer != address(0), "TokenCast: zero server");
        require(_airdropTreasury != address(0), "TokenCast: zero treasury");
        owner = msg.sender;
        signServer = _signServer;
        airdropTreasury = _airdropTreasury;
        launchTime = block.timestamp;

        uint256 chainId;
        assembly {
            chainId := chainid()
        }

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("TokenCast")),
                keccak256(bytes("1")),
                chainId,
                address(this)
            )
        );
    }

    function claim(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external notPaused {
        require(block.timestamp <= deadline, "TokenCast: voucher expired");
        require(amount > 0, "TokenCast: zero amount");
        require(lastClaimAt[msg.sender] + 1 days <= block.timestamp, "TokenCast: one claim per 24 hours");
        require(amount <= maxDailyClaimForEra(currentEra()), "TokenCast: follower cap exceeded");
        require(mintedSupply + amount <= MAX_SUPPLY, "TokenCast: max supply reached");
        require(mintedSupply + amount <= releasedSupply(), "TokenCast: emission not unlocked");

        uint256 nonce = userNonces[msg.sender]++;

        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, msg.sender, amount, nonce, deadline)
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
        );

        address recovered = ecrecover(digest, v, r, s);
        require(recovered == signServer, "TokenCast: invalid signature");

        mintedSupply += amount;
        totalClaimed[msg.sender] += amount;
        lastClaimAt[msg.sender] = block.timestamp;

        _mint(msg.sender, amount);
        emit Claimed(msg.sender, amount, totalClaimed[msg.sender]);
    }

    function currentEra() public view returns (uint256) {
        if (block.timestamp <= launchTime) return 0;
        uint256 era = (block.timestamp - launchTime) / HALVING_PERIOD;
        return era > MAX_ERA ? MAX_ERA : era;
    }

    /// @notice Reward before off-chain eligibility multipliers for an era.
    /// @dev Follower, referral, and cast verification are intentionally handled
    ///      by the signed voucher service, where Farcaster state can be verified.
    function rewardForEra(uint256 era) public pure returns (uint256) {
        if (era >= MAX_ERA) return 0;
        return BASE_SESSION_REWARD / (1 << era);
    }

    function dailyEmissionForEra(uint256 era) public pure returns (uint256) {
        if (era >= MAX_ERA) return 0;
        return BASE_DAILY_EMISSION / (1 << era);
    }

    /// @notice Calendar day index used by the backend's daily allocation ledger.
    function currentEmissionDay() public view returns (uint256) {
        return (block.timestamp - launchTime) / 1 days;
    }

    function dailyEmissionForDay(uint256 day) public pure returns (uint256) {
        return dailyEmissionForEra((day * 1 days) / HALVING_PERIOD);
    }

    /// @notice Maximum a single wallet may claim during a 24-hour window.
    /// @dev The backend verifies Farcaster follower weight; this is the immutable
    ///      100x ceiling that protects users if the API or voucher signer misbehaves.
    function maxDailyClaimForEra(uint256 era) public pure returns (uint256) {
        if (era >= MAX_ERA) return 0;
        return (BASE_SESSION_REWARD * MAX_FOLLOWER_MULTIPLIER) / (1 << era);
    }

    /// @notice Mints only the unallocated portion of a fully-settled mining day
    ///         to the immutable community Airdrop Treasury.
    /// @dev A day cannot be finalised until every possible 24-hour session opened
    ///      in that day has ended. `allocated` is the sum of all miner and referral
    ///      allocations; whether a miner has claimed is intentionally irrelevant.
    function finalizeDailyPool(
        uint256 day,
        uint256 allocated,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external notPaused {
        require(block.timestamp <= deadline, "TokenCast: finalizer expired");
        require(day + 1 < currentEmissionDay(), "TokenCast: day still settling");
        require(!dailyPoolFinalized[day], "TokenCast: day already finalized");

        uint256 dailyPool = dailyEmissionForDay(day);
        require(dailyPool > 0, "TokenCast: no emission for day");
        require(allocated <= dailyPool, "TokenCast: allocation exceeds pool");

        bytes32 structHash = keccak256(
            abi.encode(FINALIZE_DAILY_POOL_TYPEHASH, day, allocated, deadline)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
        );
        require(ecrecover(digest, v, r, s) == signServer, "TokenCast: invalid finalizer signature");

        uint256 remainder = dailyPool - allocated;
        require(mintedSupply + remainder <= MAX_SUPPLY, "TokenCast: max supply reached");
        require(mintedSupply + remainder <= releasedSupply(), "TokenCast: emission not unlocked");

        dailyPoolFinalized[day] = true;
        mintedSupply += remainder;
        _mint(airdropTreasury, remainder);
        emit DailyPoolFinalized(day, allocated, remainder);
    }

    /// @notice Supply available to claims under the calendar emission schedule.
    /// @dev This is enforced on-chain so a compromised voucher signer cannot
    /// mint future eras early.
    function releasedSupply() public view returns (uint256) {
        uint256 elapsedDays = (block.timestamp - launchTime) / 1 days;
        uint256 era = elapsedDays / (HALVING_PERIOD / 1 days);
        uint256 released;

        for (uint256 i; i < era && i < MAX_ERA; ++i) {
            released += dailyEmissionForEra(i) * (HALVING_PERIOD / 1 days);
        }

        if (era < MAX_ERA) {
            uint256 daysIntoEra = elapsedDays % (HALVING_PERIOD / 1 days);
            released += dailyEmissionForEra(era) * daysIntoEra;
        }

        return released > MAX_SUPPLY ? MAX_SUPPLY : released;
    }

    /// @notice Planned cumulative supply at which an era begins: 50%, 75%, 87.5%, etc.
    /// @dev The actual era is calendar-based, so miner count cannot accelerate halvings.
    function supplyAtEraStart(uint256 era) public pure returns (uint256) {
        if (era == 0) return 0;
        if (era >= MAX_ERA) return MAX_SUPPLY;
        return MAX_SUPPLY - (MAX_SUPPLY / (1 << era));
    }

    function remainingSupply() external view returns (uint256) {
        return MAX_SUPPLY - mintedSupply;
    }

    function setSignServer(address newServer) external onlyOwner {
        require(newServer != address(0), "TokenCast: zero server");
        emit SignServerUpdated(signServer, newServer);
        signServer = newServer;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }
}
