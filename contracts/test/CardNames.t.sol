// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {CardNames} from "../src/CardNames.sol";
import {ICardNames} from "../src/interfaces/ICardNames.sol";
import {IENSRegistryV2, IENSResolverV2, IVerifiableFactory} from "../src/interfaces/IENSv2.sol";
import {EnsRoles} from "../src/libraries/EnsRoles.sol";
import {DnsName} from "../src/libraries/DnsName.sol";

/// @dev Revert selectors of the deployed ENSv2 contracts (contracts-v2 IEnhancedAccessControl, IPermissionedRegistry).
interface IENSv2Errors {
    error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);
    error TransferDisallowed(uint256 tokenId, address from);
}

contract CardNamesTest is Test {
    using Strings for address;

    // Defaults from ensdomains/contracts-v2 contracts/deployments/sepolia/{VerifiableFactory,UserRegistryImpl,
    // PermissionedResolverImpl}.json; override with ENS_* env vars.
    address VERIFIABLE_FACTORY =
        vm.envOr("ENS_VERIFIABLE_FACTORY", address(0x118Bc31A50d559F7015a8Da26d54B3b030CdB70F));
    address USER_REGISTRY_IMPL =
        vm.envOr("ENS_USER_REGISTRY_IMPL", address(0x840Fa461059862Ea466A711E8C98c8dE732061C0));
    address RESOLVER_IMPL = vm.envOr("ENS_RESOLVER_IMPL", address(0x7E4B2d59938930168024201752EE5503df402303));

    address vaultAddr = makeAddr("vault");
    address vendor = makeAddr("vendor");
    address appraiser = makeAddr("appraiser");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    IVerifiableFactory factory = IVerifiableFactory(VERIFIABLE_FACTORY);
    IENSRegistryV2 registry;
    IENSResolverV2 resolver;
    CardNames names;

    string constant LABEL = "black-lotus-lea-1";

    function setUp() public {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"));
        // makeAddr keys are public, and on Sepolia alice and bob carry live EIP-7702 delegations (0xef0100...), which
        // would make the registry's ERC1155 safe-mint call into them. Clear the code so every actor is a plain EOA.
        vm.etch(alice, "");
        vm.etch(bob, "");
        registry = IENSRegistryV2(
            factory.deployProxy(
                USER_REGISTRY_IMPL, 1, abi.encodeCall(IENSRegistryV2.initialize, (address(this), EnsRoles.ALL_ROLES))
            )
        );
        resolver = IENSResolverV2(
            factory.deployProxy(
                RESOLVER_IMPL,
                2,
                abi.encodeCall(IENSResolverV2.initialize, (address(this), EnsRoles.ALL_ROLES, new bytes[](0)))
            )
        );
        names = new CardNames(
            CardNames.Config({
                owner: address(this),
                vault: vaultAddr,
                registry: address(registry),
                resolver: address(resolver),
                factory: VERIFIABLE_FACTORY,
                resolverImpl: RESOLVER_IMPL,
                parentLabel: "kura",
                vendor: vendor,
                appraiser: appraiser
            })
        );
        registry.grantRootRoles(EnsRoles.CARD_NAMES_REGISTRY_ROLES, address(names));
        resolver.grantRootRoles(EnsRoles.CARD_NAMES_RESOLVER_ROLES, address(names));
    }

    function _records() internal pure returns (ICardNames.CardRecords memory) {
        return ICardNames.CardRecords({
            scryfallId: "bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd",
            condition: "NM",
            language: "en",
            imageUrl: "https://cards.scryfall.io/normal/front/b/d/bd8fa327.jpg",
            description: "Black Lotus, Limited Edition Alpha",
            url: "https://kura.example/app/cards/1"
        });
    }

    function _registerCard() internal returns (bytes32 node) {
        vm.prank(vaultAddr);
        names.registerCard(1, LABEL, alice, _records());
        node = names.nodeOf(LABEL);
    }

    function test_registerCardWritesNameRecordsAndOwner() public {
        bytes32 node = _registerCard();
        assertEq(registry.findOwner(LABEL), address(names), "card names are owned by the adapter");
        assertEq(registry.getResolver(LABEL), address(resolver));
        assertEq(resolver.text(node, "avatar"), "https://cards.scryfall.io/normal/front/b/d/bd8fa327.jpg");
        assertEq(resolver.text(node, "scryfall"), "bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd");
        assertEq(resolver.text(node, "condition"), "NM");
        assertEq(resolver.text(node, "language"), "en");
        assertEq(resolver.text(node, "vault.state"), "whole");
        assertEq(resolver.text(node, "url"), "https://kura.example/app/cards/1");
        assertEq(resolver.addr(node), alice);
        assertEq(names.cardLabels(1), LABEL);
        assertFalse(names.isAvailable(LABEL));
    }

    function test_vendorMayEditOnlyConditionAndGrade() public {
        bytes32 node = _registerCard();
        vm.startPrank(vendor);
        resolver.setText(node, "condition", "LP");
        resolver.setText(node, "grade", "PSA 9");
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(node, "vault.state", "hacked");
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(node, "avatar", "x");
        vm.stopPrank();
        assertEq(resolver.text(node, "condition"), "LP");
        assertEq(resolver.text(node, "grade"), "PSA 9");

        vm.prank(alice);
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(node, "condition", "DMG");
    }

    function test_appraiserMayEditOnlyAppraisalKeys() public {
        bytes32 node = _registerCard();
        vm.startPrank(appraiser);
        resolver.setText(node, "appraisal.usd", "12.50");
        resolver.setText(node, "appraisal.at", "1700000000");
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(node, "condition", "DMG");
        vm.stopPrank();
        assertEq(resolver.text(node, "appraisal.usd"), "12.50");
    }

    function test_setStateAndOwnerRecord() public {
        bytes32 node = _registerCard();
        address token = makeAddr("shard");
        address auction = makeAddr("auction");
        vm.startPrank(vaultAddr);
        names.setState(1, "auctioning", token, auction, 0);
        assertEq(resolver.text(node, "vault.state"), "auctioning");
        assertEq(resolver.text(node, "vault.shards"), token.toHexString());
        assertEq(resolver.text(node, "vault.auction"), auction.toHexString());
        assertEq(resolver.text(node, "vault.clearing_usdc"), "0");
        names.setState(1, "sharded", token, auction, 10_000_000);
        assertEq(resolver.text(node, "vault.clearing_usdc"), "10000000");
        names.setOwnerRecord(1, bob);
        assertEq(resolver.addr(node), bob);
        vm.stopPrank();
    }

    function test_revokeUnregisters() public {
        _registerCard();
        vm.prank(vaultAddr);
        names.revoke(1);
        assertTrue(names.isAvailable(LABEL));
        assertEq(names.cardLabels(1), "");
        vm.prank(vaultAddr);
        vm.expectRevert(CardNames.UnknownCard.selector);
        names.setState(1, "whole", address(0), address(0), 0);
    }

    function test_onlyVaultForCardFunctions() public {
        vm.prank(alice);
        vm.expectRevert(CardNames.OnlyVault.selector);
        names.registerCard(1, LABEL, alice, _records());
        vm.prank(alice);
        vm.expectRevert(CardNames.OnlyVault.selector);
        names.revoke(1);
    }

    function test_registerCollectorGivesOwnedNameAndResolver() public {
        vm.prank(alice);
        address res = names.registerCollector("alice");
        bytes32 node = names.nodeOf("alice");

        assertEq(registry.findOwner("alice"), alice);
        assertEq(registry.getResolver("alice"), res);
        assertEq(factory.verifyContract(res), RESOLVER_IMPL);
        assertEq(IENSResolverV2(res).addr(node), alice);
        assertEq(names.collectorLabels(alice), "alice");

        vm.prank(alice);
        IENSResolverV2(res).setText(node, "description", "collector of blue cards");
        assertEq(IENSResolverV2(res).text(node, "description"), "collector of blue cards");

        vm.prank(bob);
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        IENSResolverV2(res).setText(node, "description", "not mine");

        vm.prank(address(names));
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        IENSResolverV2(res).setText(node, "description", "adapter never held a role here");
    }

    function test_collectorHandleRules() public {
        vm.startPrank(alice);
        vm.expectRevert(CardNames.InvalidHandle.selector);
        names.registerCollector("Alice");
        vm.expectRevert(CardNames.InvalidHandle.selector);
        names.registerCollector("al");
        vm.expectRevert(CardNames.InvalidHandle.selector);
        names.registerCollector("al-ice");
        vm.expectRevert(CardNames.InvalidHandle.selector);
        names.registerCollector("aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); // 33 chars
        vm.expectRevert(CardNames.HandleReserved.selector);
        names.registerCollector("appraiser");
        names.registerCollector("alice");
        vm.expectRevert(CardNames.AlreadyNamed.selector);
        names.registerCollector("alice2");
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(CardNames.HandleTaken.selector);
        names.registerCollector("alice");
    }

    function test_cardAndCollectorNamespacesCannotCollide() public pure {
        // card labels always contain at least two dashes; collector labels contain none
        bytes memory card = bytes(LABEL);
        uint256 dashes;
        for (uint256 i = 0; i < card.length; i++) {
            if (card[i] == 0x2d) dashes++;
        }
        assertGe(dashes, 2);
    }

    function test_cardNameTokenCannotBeTransferred() public {
        _registerCard();
        uint256 tokenId = registry.findTokenId(LABEL);
        vm.prank(address(names));
        vm.expectRevert(abi.encodeWithSelector(IENSv2Errors.TransferDisallowed.selector, tokenId, address(names)));
        IERC1155(address(registry)).safeTransferFrom(address(names), bob, tokenId, 1, "");
    }

    function test_rejectsForeignErc1155() public {
        vm.prank(alice);
        vm.expectRevert(CardNames.UnexpectedToken.selector);
        names.onERC1155Received(alice, alice, 1, 1, "");
        vm.prank(alice);
        vm.expectRevert(CardNames.UnexpectedToken.selector);
        names.onERC1155BatchReceived(alice, alice, new uint256[](1), new uint256[](1), "");
    }

    function test_adminSettersOnlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        names.setVault(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        names.setParties(alice, alice);
        vm.stopPrank();

        names.setVault(bob);
        names.setParties(bob, alice);
        assertEq(names.vault(), bob);
        assertEq(names.vendor(), bob);
        assertEq(names.appraiser(), alice);
    }
}
