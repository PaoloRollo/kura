import { parseAbi } from "viem";

const cardVault = parseAbi([
  "struct MintInput { address to; string scryfallId; string slug; string setCode; string condition; string language; string imageUrl; string description; }",
  "struct ShardParams { uint16 totalShards; uint16 forSale; uint256 floorUsdcPerShard; uint256 tickUsdcPerShard; uint128 reserveUsdc; uint40 durationBlocks; }",
  "struct Appraisal { uint256 cardId; address shardToken; uint256 usdcPerShard; uint256 expiresAt; }",
  "struct Ticket { uint8 kind; address subject; uint256 nullifier; uint256 expiresAt; }",
  "struct Card { uint8 state; address beneficialOwner; address shardToken; address auction; uint64 endBlock; string scryfallId; string condition; string language; string label; }",
  "struct Sharding { uint256 cardId; uint256 totalShards; uint256 forSale; uint256 clearingPriceQ96; bool graduated; bool settled; uint256 buyoutPerShard; uint256 payoutPool; address redeemer; }",
  "function mint(MintInput m) returns (uint256 id)",
  "function shardAndAuction(uint256 id, ShardParams p) returns (address shardToken, address auction)",
  "function settle(uint256 id)",
  "function redeem(uint256 id, Appraisal a, bytes sig)",
  "function claimPayout(address shardToken)",
  "function confirmRelease(uint256 id, Ticket t, bytes sig)",
  "function cards(uint256 id) view returns (Card)",
  "function shardings(address shardToken) view returns (Sharding)",
  "function vendor() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function payout() view returns (address)",
  "function nextId() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ticketDigest(Ticket t) view returns (bytes32)",
  "function appraisalDigest(Appraisal a) view returns (bytes32)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event CardMinted(uint256 indexed id, address indexed to, string scryfallId, string label, string condition, string language)",
  "event CardSharded(uint256 indexed id, address indexed shardToken, address indexed auction, uint16 totalShards, uint16 forSale, uint64 startBlock, uint64 endBlock, uint256 floorPriceQ96, uint256 tickSpacingQ96, uint128 reserveUsdc)",
  "event AuctionSettled(uint256 indexed id, address indexed shardToken, uint256 clearingPriceQ96, uint256 raisedUsdc, uint256 feeUsdc, bool graduated)",
  "event CardRedeemed(uint256 indexed id, address indexed shardToken, address indexed redeemer, uint256 buyoutPerShard, uint256 payoutUsdc, uint256 feeUsdc)",
  "event PayoutClaimed(uint256 indexed id, address indexed shardToken, address indexed holder, uint256 shardUnits, uint256 usdc)",
  "event CardReleased(uint256 indexed id, address indexed holder)",
  "event FeeAccrued(uint256 indexed id, uint8 kind, uint256 amountUsdc)",
]);

const bidGateHook = parseAbi([
  "function nullifierOwner(uint256 nullifier) view returns (address)",
  "function signer() view returns (address)",
  "event BidderBound(uint256 indexed nullifier, address indexed wallet)",
]);

const cardNames = parseAbi([
  "function registerCollector(string label) returns (address collectorResolver)",
  "function isAvailable(string label) view returns (bool)",
  "function collectorLabels(address collector) view returns (string)",
  "function cardLabels(uint256 cardId) view returns (string)",
  "function nodeOf(string label) view returns (bytes32)",
  "function parentLabel() view returns (string)",
  "event CardNamed(uint256 indexed cardId, string label, bytes32 node)",
  "event CardNameRevoked(uint256 indexed cardId, string label)",
  "event CollectorNamed(address indexed collector, string label, address resolver, bytes32 node)",
]);

const ccaAuction = parseAbi([
  "struct Bid { uint64 startBlock; uint24 startCumulativeMps; uint64 exitedBlock; uint256 maxPrice; address owner; uint256 amountQ96; uint256 tokensFilled; }",
  "function submitBid(uint256 maxPriceQ96, uint128 amount, address owner, bytes hookData) payable returns (uint256 bidId)",
  "function exitBid(uint256 bidId)",
  "function exitPartiallyFilledBid(uint256 bidId, uint64 lastFullyFilledCheckpointBlock, uint64 outbidBlock)",
  "function claimTokens(uint256 bidId)",
  "function clearingPrice() view returns (uint256)",
  "function isGraduated() view returns (bool)",
  "function startBlock() view returns (uint64)",
  "function endBlock() view returns (uint64)",
  "function claimBlock() view returns (uint64)",
  "function floorPrice() view returns (uint256)",
  "function tickSpacing() view returns (uint256)",
  "function totalSupply() view returns (uint128)",
  "function currencyRaised() view returns (uint256)",
  "function totalCleared() view returns (uint256)",
  "function remainingSupply() view returns (uint256)",
  "function nextBidId() view returns (uint256)",
  "function bids(uint256 bidId) view returns (Bid)",
  "event BidSubmitted(uint256 indexed id, address indexed owner, uint256 priceQ96, uint128 amount)",
  "event BidExited(uint256 indexed bidId, address indexed owner, uint256 tokensFilled, uint256 currencyRefunded)",
  "event TokensClaimed(uint256 indexed bidId, address indexed owner, uint256 tokensFilled)",
  "event CurrencySwept(address indexed fundsRecipient, uint256 currencyAmount)",
  "event TokensSwept(address indexed tokensRecipient, uint256 tokensAmount)",
]);

const erc20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

const permit2 = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

const ensResolver = parseAbi([
  "function setText(bytes32 node, string key, string value)",
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
  "event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)",
  "event AddrChanged(bytes32 indexed node, address a)",
]);

const ensRegistry = parseAbi([
  "function findExpiry(string label) view returns (uint64)",
  "function findOwner(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
  "event LabelUnregistered(uint256 indexed tokenId, address indexed sender)",
]);

export const abi = { cardVault, bidGateHook, cardNames, ccaAuction, shardToken: erc20, erc20, permit2, ensResolver, ensRegistry } as const;
