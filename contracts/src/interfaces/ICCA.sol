// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal interfaces for Uniswap's Continuous Clearing Auction v2.1.0 (commit 7d7602d).
/// Signatures are copied from the repository; return types that are interfaces there are declared as address here
/// (ABI-identical). `checkpoint()` returns a struct upstream; declaring no return value is ABI-safe for callers.

struct AuctionParameters {
    address currency; // token to raise funds in. Use address(0) for ETH
    address tokensRecipient; // address to receive leftover tokens
    address fundsRecipient; // address to receive all raised funds
    uint64 startBlock; // Block which the first step starts
    uint64 endBlock; // When the auction finishes
    uint64 claimBlock; // Block when the auction can claimed
    uint256 tickSpacing; // Fixed Q96 granularity for prices
    address validationHook; // Optional hook called before a bid
    uint256 floorPrice; // Starting Q96 floor price for the auction
    uint128 requiredCurrencyRaised; // Amount of currency required to be raised for the auction to graduate
    bytes auctionStepsData; // Packed bytes describing token issuance schedule
}

struct Bid {
    uint64 startBlock;
    uint24 startCumulativeMps;
    uint64 exitedBlock;
    uint256 maxPrice;
    address owner;
    uint256 amountQ96;
    uint256 tokensFilled;
}

interface ICCAFactory {
    event AuctionCreated(address indexed auction, address indexed token, uint256 amount, bytes configData);

    function create(address token, uint256 totalSupply, bytes calldata configData, bytes32 salt) external returns (address auction);
}

interface ICCAAuction {
    event TokensReceived(uint128 totalSupply);
    event BidSubmitted(uint256 indexed id, address indexed owner, uint256 priceQ96, uint128 amount);
    event BidExited(uint256 indexed bidId, address indexed owner, uint256 tokensFilled, uint256 currencyRefunded);
    event TokensClaimed(uint256 indexed bidId, address indexed owner, uint256 tokensFilled);
    event CurrencySwept(address indexed fundsRecipient, uint256 currencyAmount);
    event TokensSwept(address indexed tokensRecipient, uint256 tokensAmount);

    function onTokensReceived() external;
    function submitBid(uint256 maxPriceQ96, uint128 amount, address owner, bytes calldata hookData)
        external
        payable
        returns (uint256 bidId);
    function exitBid(uint256 bidId) external;
    function exitPartiallyFilledBid(uint256 bidId, uint64 lastFullyFilledCheckpointBlock, uint64 outbidBlock) external;
    function claimTokens(uint256 bidId) external;
    function checkpoint() external;
    function clearingPrice() external view returns (uint256);
    function isGraduated() external view returns (bool);
    function sweepCurrency() external;
    function sweepUnsoldTokens() external;

    function startBlock() external view returns (uint64);
    function endBlock() external view returns (uint64);
    function claimBlock() external view returns (uint64);
    function floorPrice() external view returns (uint256);
    function tickSpacing() external view returns (uint256);
    function totalSupply() external view returns (uint128);
    function currencyRaised() external view returns (uint256);
    function totalCleared() external view returns (uint256);
    function remainingSupply() external view returns (uint256);
    function nextBidId() external view returns (uint256);
    function bids(uint256 bidId) external view returns (Bid memory);
    function validationHook() external view returns (address);
    function fundsRecipient() external view returns (address);
    function tokensRecipient() external view returns (address);
    function currency() external view returns (address);
    function token() external view returns (address);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}
