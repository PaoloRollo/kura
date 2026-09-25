// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CardVault} from "../../src/CardVault.sol";
import {BidGateHook} from "../../src/BidGateHook.sol";
import {Tickets} from "../../src/libraries/Tickets.sol";
import {ICCAAuction, IPermit2} from "../../src/interfaces/ICCA.sol";
import {MockCardNames} from "./MockCardNames.sol";

abstract contract ForkTest is Test {
    address constant CCA_FACTORY = 0x000000001F26a0044BaA66024e7b6599c61963F8;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    IERC20 constant USDC = IERC20(0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238);

    uint256 signerPk = 0xA11CE;
    address signer;
    address deployer = makeAddr("deployer");
    address vendor = makeAddr("vendor");
    address payout = makeAddr("payout");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    MockCardNames names;
    BidGateHook hook;
    CardVault vault;

    function setUp() public virtual {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"));
        signer = vm.addr(signerPk);
        _deployStack(250);
    }

    function _deployStack(uint16 feeBps) internal {
        names = new MockCardNames();
        hook = new BidGateHook(signer, deployer);
        vault = new CardVault(
            CardVault.Config({
                owner: deployer,
                vendor: vendor,
                feeBps: feeBps,
                payout: payout,
                signer: signer,
                usdc: address(USDC),
                ccaFactory: CCA_FACTORY,
                hook: address(hook),
                names: address(names),
                baseURI: "https://kura.example/api/meta/",
                siteURI: "https://kura.example/app/cards/"
            })
        );
    }

    function _mintTo(address to) internal returns (uint256 id) {
        vm.prank(vendor);
        id = vault.mint(
            CardVault.MintInput({
                to: to,
                scryfallId: "bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd",
                slug: "black-lotus",
                setCode: "lea",
                condition: "NM",
                language: "en",
                imageUrl: "https://cards.scryfall.io/normal/front/b/d/bd8fa327.jpg",
                description: "Black Lotus, Limited Edition Alpha"
            })
        );
    }

    function _defaultParams() internal pure returns (CardVault.ShardParams memory) {
        return CardVault.ShardParams({
            totalShards: 16,
            forSale: 3,
            floorUsdcPerShard: 10_000_000,
            tickUsdcPerShard: 500_000,
            reserveUsdc: 0,
            durationBlocks: 20
        });
    }

    /// @dev Adds `amount` to `to`'s USDC balance on the fork. If `deal` cannot find the balance slot for Circle's proxy, replace the body
    /// with the minter path: `vm.prank(IUsdcAdmin(address(USDC)).masterMinter()); IUsdcAdmin(address(USDC)).configureMinter(address(this), type(uint256).max); IUsdcAdmin(address(USDC)).mint(to, amount);`
    function _dealUsdc(address to, uint256 amount) internal {
        deal(address(USDC), to, USDC.balanceOf(to) + amount);
    }

    function _permitAuction(address bidder, address auction, uint160 amount) internal {
        vm.startPrank(bidder);
        USDC.approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(address(USDC), auction, amount, uint48(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function _humanTicket(address subject, uint256 nullifier) internal view returns (bytes memory hookData) {
        Tickets.Ticket memory t =
            Tickets.Ticket({kind: Tickets.KIND_HUMAN, subject: subject, nullifier: nullifier, expiresAt: block.timestamp + 1 days});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, hook.ticketDigest(t));
        return abi.encode(t, abi.encodePacked(r, s, v));
    }

    function _passportTicket(address subject, uint256 nullifier) internal view returns (Tickets.Ticket memory t, bytes memory sig) {
        t = Tickets.Ticket({kind: Tickets.KIND_PASSPORT, subject: subject, nullifier: nullifier, expiresAt: block.timestamp + 15 minutes});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, vault.ticketDigest(t));
        sig = abi.encodePacked(r, s, v);
    }

    function _appraisal(uint256 cardId, address shardToken, uint256 usdcPerShard)
        internal
        view
        returns (Tickets.Appraisal memory a, bytes memory sig)
    {
        a = Tickets.Appraisal({cardId: cardId, shardToken: shardToken, usdcPerShard: usdcPerShard, expiresAt: block.timestamp + 10 minutes});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, vault.appraisalDigest(a));
        sig = abi.encodePacked(r, s, v);
    }

    /// @dev Funds, permits and bids in one go. `nullifier` is derived from the bidder so each wallet is a distinct human.
    /// @dev Nullifiers come from the bidder address (distinct humans); "same human, two wallets" tests must call `_humanTicket` with a shared nullifier directly.
    function _bid(address bidder, address auction, uint256 maxPriceQ96, uint128 amount) internal returns (uint256 bidId) {
        _dealUsdc(bidder, amount);
        _permitAuction(bidder, auction, amount);
        bytes memory data = _humanTicket(bidder, uint256(uint160(bidder)));
        vm.prank(bidder);
        bidId = ICCAAuction(auction).submitBid(maxPriceQ96, amount, bidder, data);
    }
}
