// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CardVault} from "../src/CardVault.sol";
import {ICardNames} from "../src/interfaces/ICardNames.sol";
import {MockCardNames} from "./utils/MockCardNames.sol";

contract CardVaultMintTest is Test {
    address owner = makeAddr("owner");
    address vendor = makeAddr("vendor");
    address payout = makeAddr("payout");
    address signer = makeAddr("signer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    MockCardNames names;
    CardVault vault;

    function _config(uint16 feeBps) internal returns (CardVault.Config memory) {
        return CardVault.Config({
            owner: owner,
            vendor: vendor,
            feeBps: feeBps,
            payout: payout,
            signer: signer,
            usdc: makeAddr("usdc"),
            ccaFactory: makeAddr("factory"),
            hook: makeAddr("hook"),
            names: address(names),
            baseURI: "https://kura.example/api/meta/",
            siteURI: "https://kura.example/app/cards/"
        });
    }

    function setUp() public {
        names = new MockCardNames();
        vault = new CardVault(_config(250));
    }

    function _input(address to) internal pure returns (CardVault.MintInput memory) {
        return CardVault.MintInput({
            to: to,
            scryfallId: "bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd",
            slug: "black-lotus",
            setCode: "lea",
            condition: "NM",
            language: "en",
            imageUrl: "https://cards.scryfall.io/normal/front/b/d/bd8fa327.jpg",
            description: "Black Lotus, Limited Edition Alpha"
        });
    }

    function test_vendorMintsCard() public {
        vm.prank(vendor);
        vm.expectEmit(true, true, true, true);
        emit CardVault.CardMinted(1, alice, "bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd", "black-lotus-lea-1", "NM", "en");
        uint256 id = vault.mint(_input(alice));

        assertEq(id, 1);
        assertEq(vault.nextId(), 2);
        assertEq(vault.ownerOf(1), alice);
        CardVault.Card memory c = vault.cards(1);
        assertEq(uint8(c.state), uint8(CardVault.State.Whole));
        assertEq(c.beneficialOwner, alice);
        assertEq(c.label, "black-lotus-lea-1");
        assertEq(c.condition, "NM");
        assertEq(c.language, "en");
        assertEq(c.shardToken, address(0));

        (uint256 cardId, string memory label, address recOwner, ICardNames.CardRecords memory r) = names.lastRegister();
        assertEq(cardId, 1);
        assertEq(label, "black-lotus-lea-1");
        assertEq(recOwner, alice);
        assertEq(r.url, "https://kura.example/app/cards/1");
        assertEq(r.imageUrl, "https://cards.scryfall.io/normal/front/b/d/bd8fa327.jpg");
        assertEq(r.language, "en");
    }

    function test_labelUsesTokenId() public {
        vm.startPrank(vendor);
        vault.mint(_input(alice));
        vault.mint(_input(bob));
        vm.stopPrank();
        assertEq(vault.cards(2).label, "black-lotus-lea-2");
        assertEq(vault.ownerOf(2), bob);
    }

    function test_nonVendorCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(CardVault.OnlyVendor.selector);
        vault.mint(_input(alice));
    }

    function test_rejectsBadSlugOrSetCode() public {
        CardVault.MintInput memory m = _input(alice);
        vm.startPrank(vendor);
        m.slug = "Black-Lotus";
        vm.expectRevert(CardVault.InvalidLabel.selector);
        vault.mint(m);
        m.slug = "-black-lotus";
        vm.expectRevert(CardVault.InvalidLabel.selector);
        vault.mint(m);
        m.slug = "black_lotus";
        vm.expectRevert(CardVault.InvalidLabel.selector);
        vault.mint(m);
        m.slug = "";
        vm.expectRevert(CardVault.InvalidLabel.selector);
        vault.mint(m);
        m.slug = "black-lotus";
        m.setCode = "le-a";
        vm.expectRevert(CardVault.InvalidLabel.selector);
        vault.mint(m);
        vm.stopPrank();
    }

    function test_rejectsBadConditionOrLanguage() public {
        CardVault.MintInput memory m = _input(alice);
        vm.startPrank(vendor);
        m.condition = "MINT";
        vm.expectRevert(CardVault.InvalidCondition.selector);
        vault.mint(m);
        m.condition = "NM";
        m.language = "";
        vm.expectRevert(CardVault.InvalidLanguage.selector);
        vault.mint(m);
        m.language = "english";
        vm.expectRevert(CardVault.InvalidLanguage.selector);
        vault.mint(m);
        m.language = "zhs";
        vault.mint(m);
        vm.stopPrank();
    }

    function test_tokenURI() public {
        vm.prank(vendor);
        vault.mint(_input(alice));
        assertEq(vault.tokenURI(1), "https://kura.example/api/meta/1");
    }

    function test_feeCap() public {
        vm.expectRevert(CardVault.FeeTooHigh.selector);
        new CardVault(_config(1001));
        vm.prank(owner);
        vm.expectRevert(CardVault.FeeTooHigh.selector);
        vault.setFee(1001, payout);
        vm.prank(owner);
        vault.setFee(1000, payout);
        assertEq(vault.feeBps(), 1000);
    }

    function test_adminFunctionsAreOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setVendor(alice);
        vm.prank(owner);
        vault.setVendor(alice);
        assertEq(vault.vendor(), alice);
    }

    function test_transferOfWholeCardSyncsBeneficialOwner() public {
        vm.prank(vendor);
        vault.mint(_input(alice));
        vm.prank(alice);
        vault.transferFrom(alice, bob, 1);
        assertEq(vault.ownerOf(1), bob);
        assertEq(vault.cards(1).beneficialOwner, bob);
        assertEq(names.ownerRecords(1), bob);
    }
}
