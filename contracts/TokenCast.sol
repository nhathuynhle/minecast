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
    uint256 public constant MAX_SUPPLY = 21_000_000_000 * 1e18; // 21 Tỷ
    uint256 public constant BASE_SESSION_REWARD = 8_000 * 1e18; // Era 0: 8 000 TOKENCAST

    address public owner;
    address public signServer;
    bool    public paused;

    uint256 public mintedSupply;
    mapping(address => uint256) public userNonces;
    mapping(address => uint256) public totalClaimed;

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "ClaimVoucher(address user,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    event Claimed(address indexed user, uint256 amount, uint256 newTotalClaimed);
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

    constructor(address _signServer) {
        require(_signServer != address(0), "TokenCast: zero server");
        owner = msg.sender;
        signServer = _signServer;

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
        require(mintedSupply + amount <= MAX_SUPPLY, "TokenCast: max supply reached");

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

        _mint(msg.sender, amount);
        emit Claimed(msg.sender, amount, totalClaimed[msg.sender]);
    }

    function currentEra() public view returns (uint256) {
        if (mintedSupply == 0) return 0;
        uint256 remaining = MAX_SUPPLY - mintedSupply;
        if (remaining == 0) return 32;
        uint256 era = 0;
        uint256 threshold = MAX_SUPPLY;
        while (era < 32 && remaining < threshold / 2) {
            threshold /= 2;
            era++;
        }
        return era;
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
