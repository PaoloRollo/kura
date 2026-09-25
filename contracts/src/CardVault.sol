// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {TicketVerifier} from "./TicketVerifier.sol";
import {Tickets} from "./libraries/Tickets.sol";
import {PriceMath} from "./libraries/PriceMath.sol";
import {ICardNames} from "./interfaces/ICardNames.sol";

/// @notice Kura vault: one ERC-721 per physical card held by the vendor. Owns sharding, auctions, buyouts and release.
contract CardVault is ERC721, TicketVerifier, Ownable {
    using Strings for uint256;
    using SafeERC20 for IERC20;

    enum State {
        None,
        Whole,
        Auctioning,
        Sharded,
        Released
    }

    enum FeeKind {
        Sale,
        Buyout
    }

    struct Card {
        State state;
        address beneficialOwner; // NFT owner, or the sharder while the NFT is escrowed here
        address shardToken; // current sharding, zero when Whole or Released
        address auction; // current CCA, zero when none
        uint64 endBlock;
        string scryfallId;
        string condition; // NM | LP | MP | HP | DMG
        string language; // Scryfall language code
        string label; // ENS label, e.g. black-lotus-lea-1
    }

    struct Sharding {
        uint256 cardId;
        uint256 totalShards; // whole shards, N
        uint256 forSale; // whole shards sent to the auction
        uint256 clearingPriceQ96; // set at settle
        bool graduated;
        bool settled;
        uint256 buyoutPerShard; // USDC units per whole shard, set at redeem
        uint256 payoutPool; // USDC reserved for minority claims
        address redeemer;
    }

    struct ShardParams {
        uint16 totalShards; // 16..512, multiple of 16
        uint16 forSale; // 1..totalShards
        uint256 floorUsdcPerShard; // USDC units per whole shard, multiple of tickUsdcPerShard
        uint256 tickUsdcPerShard; // USDC units per whole shard, >= 1
        uint128 reserveUsdc; // graduation threshold, 0 = none
        uint40 durationBlocks; // >= 2
    }

    struct MintInput {
        address to;
        string scryfallId;
        string slug;
        string setCode;
        string condition;
        string language;
        string imageUrl;
        string description;
    }

    struct Config {
        address owner;
        address vendor;
        uint16 feeBps;
        address payout;
        address signer;
        address usdc;
        address ccaFactory;
        address hook;
        address names;
        string baseURI;
        string siteURI;
    }

    uint16 public constant MAX_FEE_BPS = 1000;
    uint16 public constant MIN_SHARDS = 16;
    uint16 public constant MAX_SHARDS = 512;
    uint16 public constant SHARD_STEP = 16;

    IERC20 public immutable usdc;
    address public immutable ccaFactory;
    address public immutable hook;

    address public vendor;
    uint16 public feeBps;
    address public payout;
    ICardNames public names;
    string public siteURI;
    string private _baseTokenURI;

    uint256 public nextId = 1;
    mapping(uint256 cardId => Card) private _cards;
    mapping(address shardToken => Sharding) private _shardings;
    mapping(bytes32 digest => bool) public usedTickets;

    event CardMinted(uint256 indexed id, address indexed to, string scryfallId, string label, string condition, string language);
    event VendorUpdated(address vendor);
    event FeeUpdated(uint16 feeBps, address payout);

    error OnlyVendor();
    error FeeTooHigh();
    error ZeroAddress();
    error InvalidLabel();
    error InvalidCondition();
    error InvalidLanguage();
    error WrongState(uint256 cardId, State actual);
    error NotCardOwner();

    modifier onlyVendor() {
        if (msg.sender != vendor) revert OnlyVendor();
        _;
    }

    constructor(Config memory c) ERC721("Kura Card", "KURA") TicketVerifier("Kura CardVault", c.signer) Ownable(c.owner) {
        if (c.vendor == address(0) || c.payout == address(0) || c.usdc == address(0) || c.names == address(0)) revert ZeroAddress();
        if (c.feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        vendor = c.vendor;
        feeBps = c.feeBps;
        payout = c.payout;
        usdc = IERC20(c.usdc);
        ccaFactory = c.ccaFactory;
        hook = c.hook;
        names = ICardNames(c.names);
        _baseTokenURI = c.baseURI;
        siteURI = c.siteURI;
    }

    // ---------------------------------------------------------------- admin

    function setVendor(address v) external onlyOwner {
        if (v == address(0)) revert ZeroAddress();
        vendor = v;
        emit VendorUpdated(v);
    }

    function setFee(uint16 bps, address p) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        if (p == address(0)) revert ZeroAddress();
        feeBps = bps;
        payout = p;
        emit FeeUpdated(bps, p);
    }

    function setSigner(address s) external onlyOwner {
        _setSigner(s);
    }

    function setNames(address n) external onlyOwner {
        if (n == address(0)) revert ZeroAddress();
        names = ICardNames(n);
    }

    function setURIs(string calldata baseURI_, string calldata siteURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
        siteURI = siteURI_;
    }

    // ---------------------------------------------------------------- views

    function cards(uint256 id) external view returns (Card memory) {
        return _cards[id];
    }

    function shardings(address shardToken) external view returns (Sharding memory) {
        return _shardings[shardToken];
    }

    // ---------------------------------------------------------------- mint

    /// @notice Mint the digital twin of a physical card now held in the vault. Vendor only.
    function mint(MintInput calldata m) external onlyVendor returns (uint256 id) {
        if (m.to == address(0)) revert ZeroAddress();
        _requireLabelPart(m.slug, true);
        _requireLabelPart(m.setCode, false);
        _requireCondition(m.condition);
        _requireLanguage(m.language);

        id = nextId++;
        string memory label = string.concat(m.slug, "-", m.setCode, "-", id.toString());

        Card storage c = _cards[id];
        c.state = State.Whole;
        c.beneficialOwner = m.to;
        c.scryfallId = m.scryfallId;
        c.condition = m.condition;
        c.language = m.language;
        c.label = label;

        _mint(m.to, id);

        names.registerCard(
            id,
            label,
            m.to,
            ICardNames.CardRecords({
                scryfallId: m.scryfallId,
                condition: m.condition,
                language: m.language,
                imageUrl: m.imageUrl,
                description: m.description,
                url: string.concat(siteURI, id.toString())
            })
        );

        emit CardMinted(id, m.to, m.scryfallId, label, m.condition, m.language);
    }

    // ---------------------------------------------------------------- internals

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    /// @dev Keep beneficialOwner and the ENS address record in sync when a Whole card changes hands.
    /// Escrow (to == this), release from escrow (from == this) and mint (from == 0) are handled by their own functions.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        Card storage c = _cards[tokenId];
        if (c.state == State.Whole && from != address(0) && from != address(this) && to != address(this) && to != address(0)) {
            c.beneficialOwner = to;
            names.setOwnerRecord(tokenId, to);
        }
    }

    function _requireLabelPart(string memory s, bool allowDash) internal pure {
        bytes memory b = bytes(s);
        if (b.length == 0 || b.length > 48) revert InvalidLabel();
        if (allowDash && (b[0] == 0x2d || b[b.length - 1] == 0x2d)) revert InvalidLabel();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 ch = b[i];
            bool digit = ch >= 0x30 && ch <= 0x39;
            bool lower = ch >= 0x61 && ch <= 0x7a;
            bool dash = allowDash && ch == 0x2d;
            if (!digit && !lower && !dash) revert InvalidLabel();
        }
    }

    function _requireCondition(string memory s) internal pure {
        bytes32 h = keccak256(bytes(s));
        if (
            h != keccak256("NM") && h != keccak256("LP") && h != keccak256("MP") && h != keccak256("HP")
                && h != keccak256("DMG")
        ) revert InvalidCondition();
    }

    function _requireLanguage(string memory s) internal pure {
        bytes memory b = bytes(s);
        if (b.length < 2 || b.length > 3) revert InvalidLanguage();
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] < 0x61 || b[i] > 0x7a) revert InvalidLanguage();
        }
    }
}
