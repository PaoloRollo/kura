// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {CardNames} from "../src/CardNames.sol";
import {ICardNames} from "../src/interfaces/ICardNames.sol";
import {EnsGrant, IENSRegistryV2, IENSResolverV2, IVerifiableFactory} from "../src/interfaces/IENSv2.sol";
import {EnsRoles} from "../src/libraries/EnsRoles.sol";
import {DnsName} from "../src/libraries/DnsName.sol";
import {EnsFork} from "./utils/EnsFork.sol";

/// @dev Revert selectors of the deployed ENSv2 contracts (contracts-v2 IEnhancedAccessControl, IPermissionedRegistry).
interface IENSv2Errors {
    error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);
    error TransferDisallowed(uint256 tokenId, address from);
}

/// @dev Runs CardNames against the live ENSv2 Sepolia deployment: a fresh `<PARENT>.eth` is registered on the real
/// ETHRegistrar with a new UserRegistry and PermissionedResolver, and every read goes through UniversalResolverV2.
contract CardNamesTest is EnsFork {
    using Strings for address;

    string constant PARENT = "kuranamesfork";
    string constant LABEL = "black-lotus-lea-1";

    address vaultAddr = makeAddr("vault");
    address vendor = makeAddr("vendor");
    address appraiser = makeAddr("appraiser");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address ensOwner = makeAddr("ensOwner");

    IVerifiableFactory factory;
    IENSRegistryV2 registry;
    IENSResolverV2 resolver;
    CardNames names;

    function setUp() public {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"));
        // makeAddr keys are public, and on Sepolia some carry live EIP-7702 delegations (0xef0100...), which would make
        // the registry's ERC1155 safe-mint call into them. Clear the code so every actor is a plain EOA.
        vm.etch(alice, "");
        vm.etch(bob, "");
        vm.etch(ensOwner, "");
        factory = IVerifiableFactory(ENS_VERIFIABLE_FACTORY);

        EnsGrant[] memory grants = new EnsGrant[](1);
        grants[0] = EnsGrant({account: address(this), roleBitmap: EnsRoles.ALL_ROLES});
        registry = IENSRegistryV2(
            factory.deployProxy(ENS_USER_REGISTRY_IMPL, 1, abi.encodeCall(IENSRegistryV2.initialize, (grants)))
        );
        resolver = IENSResolverV2(
            factory.deployProxy(
                ENS_RESOLVER_IMPL, 2, abi.encodeCall(IENSResolverV2.initialize, (grants, new bytes[](0)))
            )
        );
        _registerEth(PARENT, ensOwner, address(registry), address(resolver));
        registry.setParent(ENS_ETH_REGISTRY, PARENT);

        names = new CardNames(
            CardNames.Config({
                owner: address(this),
                vault: vaultAddr,
                registry: address(registry),
                resolver: address(resolver),
                factory: ENS_VERIFIABLE_FACTORY,
                resolverImpl: ENS_RESOLVER_IMPL,
                parentLabel: PARENT,
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

    function _registerCard() internal returns (bytes memory dns) {
        vm.prank(vaultAddr);
        names.registerCard(1, LABEL, alice, _records());
        dns = names.dnsOf(LABEL);
    }

    function _text(string memory label, string memory key) internal view returns (string memory) {
        return _urText(names.dnsOf(label), names.nodeOf(label), key);
    }

    function _addr(string memory label) internal view returns (address) {
        return _urAddr(names.dnsOf(label), names.nodeOf(label));
    }

    function test_registerCardResolvesThroughUniversalResolver() public {
        _registerCard();
        assertEq(registry.findOwner(LABEL), address(names), "card names are owned by the adapter");
        assertEq(registry.getResolver(LABEL), address(resolver));
        assertEq(_urResolver(names.dnsOf(LABEL)), address(resolver), "UR finds the shared resolver");
        assertEq(_text(LABEL, "avatar"), "https://cards.scryfall.io/normal/front/b/d/bd8fa327.jpg");
        assertEq(_text(LABEL, "description"), "Black Lotus, Limited Edition Alpha");
        assertEq(_text(LABEL, "scryfall"), "bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd");
        assertEq(_text(LABEL, "condition"), "NM");
        assertEq(_text(LABEL, "language"), "en");
        assertEq(_text(LABEL, "vault.state"), "whole");
        assertEq(_text(LABEL, "url"), "https://kura.example/app/cards/1");
        assertEq(_addr(LABEL), alice);
        assertEq(names.cardLabels(1), LABEL);
        assertFalse(names.isAvailable(LABEL));
    }

    function test_vendorMayEditOnlyConditionAndGrade() public {
        bytes memory dns = _registerCard();
        vm.startPrank(vendor);
        resolver.setText(dns, "condition", "LP");
        resolver.setText(dns, "grade", "PSA 9");
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(dns, "vault.state", "hacked");
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(dns, "avatar", "x");
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(dns, "appraisal.usd", "1");
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setAddress(dns, 60, abi.encodePacked(vendor));
        vm.stopPrank();
        assertEq(_text(LABEL, "condition"), "LP");
        assertEq(_text(LABEL, "grade"), "PSA 9");

        vm.prank(alice);
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(dns, "condition", "DMG");
    }

    function test_appraiserMayEditOnlyAppraisalKeys() public {
        bytes memory dns = _registerCard();
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(IENSResolverV2.setText, (dns, "appraisal.usd", "12.50"));
        calls[1] = abi.encodeCall(IENSResolverV2.setText, (dns, "appraisal.at", "1700000000"));
        vm.startPrank(appraiser);
        resolver.multicall(calls);
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(dns, "condition", "DMG");
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(dns, "grade", "PSA 1");
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(dns, "vault.state", "released");
        vm.stopPrank();
        assertEq(_text(LABEL, "appraisal.usd"), "12.50");
        assertEq(_text(LABEL, "appraisal.at"), "1700000000");
        assertEq(_text(LABEL, "condition"), "NM");
    }

    function test_setPartiesMovesRecordRights() public {
        bytes memory dns = _registerCard();
        address vendor2 = makeAddr("vendor2");
        address appraiser2 = makeAddr("appraiser2");
        names.setParties(vendor2, appraiser2);

        vm.prank(vendor);
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(dns, "condition", "LP");
        vm.prank(appraiser);
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        resolver.setText(dns, "appraisal.usd", "1");

        vm.prank(vendor2);
        resolver.setText(dns, "grade", "BGS 9.5");
        vm.prank(appraiser2);
        resolver.setText(dns, "appraisal.usd", "2");
        assertEq(_text(LABEL, "grade"), "BGS 9.5");
        assertEq(_text(LABEL, "appraisal.usd"), "2");
    }

    function test_setStateAndOwnerRecord() public {
        _registerCard();
        address token = makeAddr("shard");
        address auction = makeAddr("auction");
        vm.startPrank(vaultAddr);
        names.setState(1, "auctioning", token, auction, 0);
        assertEq(_text(LABEL, "vault.state"), "auctioning");
        assertEq(_text(LABEL, "vault.shards"), token.toHexString());
        assertEq(_text(LABEL, "vault.auction"), auction.toHexString());
        assertEq(_text(LABEL, "vault.clearing_usdc"), "0");
        names.setState(1, "sharded", token, auction, 10_000_000);
        assertEq(_text(LABEL, "vault.state"), "sharded");
        assertEq(_text(LABEL, "vault.clearing_usdc"), "10000000");
        names.setState(1, "whole", address(0), address(0), 12_000_000);
        assertEq(_text(LABEL, "vault.shards"), "");
        names.setOwnerRecord(1, bob);
        assertEq(_addr(LABEL), bob);
        vm.stopPrank();
    }

    function test_revokeUnregisters() public {
        _registerCard();
        vm.prank(vaultAddr);
        names.revoke(1);
        assertTrue(names.isAvailable(LABEL));
        assertEq(registry.findOwner(LABEL), address(0));
        assertEq(registry.getResolver(LABEL), address(0));
        assertEq(names.cardLabels(1), "");
        vm.prank(vaultAddr);
        vm.expectRevert(CardNames.UnknownCard.selector);
        names.setState(1, "whole", address(0), address(0), 0);
    }

    function test_onlyVaultForCardFunctions() public {
        vm.startPrank(alice);
        vm.expectRevert(CardNames.OnlyVault.selector);
        names.registerCard(1, LABEL, alice, _records());
        vm.expectRevert(CardNames.OnlyVault.selector);
        names.setState(1, "whole", address(0), address(0), 0);
        vm.expectRevert(CardNames.OnlyVault.selector);
        names.setOwnerRecord(1, alice);
        vm.expectRevert(CardNames.OnlyVault.selector);
        names.revoke(1);
        vm.stopPrank();
    }

    function test_registerCollectorGivesOwnedNameAndResolver() public {
        vm.prank(alice);
        address res = names.registerCollector("alice");
        bytes memory dns = names.dnsOf("alice");

        assertEq(registry.findOwner("alice"), alice);
        assertEq(registry.getResolver("alice"), res);
        assertEq(factory.verifyContract(res), ENS_RESOLVER_IMPL);
        assertEq(_urResolver(dns), res, "UR finds the collector's own resolver");
        assertEq(_addr("alice"), alice);
        assertEq(names.collectorLabels(alice), "alice");

        vm.prank(alice);
        IENSResolverV2(res).setText(dns, "description", "collector of blue cards");
        assertEq(_text("alice", "description"), "collector of blue cards");
        vm.prank(alice);
        IENSResolverV2(res).setAddress(dns, 60, abi.encodePacked(bob));
        assertEq(_addr("alice"), bob);

        vm.prank(bob);
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        IENSResolverV2(res).setText(dns, "description", "not mine");

        vm.prank(address(names));
        vm.expectPartialRevert(IENSv2Errors.EACUnauthorizedAccountRoles.selector);
        IENSResolverV2(res).setText(dns, "description", "adapter never held a role here");
        assertEq(IENSResolverV2(res).roles(0, address(names)), 0);
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
        // safe transfers are refused outright while the registry holds root roles (not emancipated)
        vm.prank(address(names));
        vm.expectRevert();
        IERC1155(address(registry)).safeTransferFrom(address(names), bob, tokenId, 1, "");
        // and the token itself carries no CAN_TRANSFER_ADMIN
        vm.prank(address(names));
        vm.expectRevert(abi.encodeWithSelector(IENSv2Errors.TransferDisallowed.selector, tokenId, address(names)));
        registry.unsafeTransfer(bob, tokenId, "");
        assertEq(registry.findOwner(LABEL), address(names));
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

    function test_dnsAndNodeMatchTheParent() public view {
        assertEq(names.parentNode(), DnsName.node(DnsName.ETH_NODE, PARENT));
        assertEq(names.dnsOf("x"), abi.encodePacked(hex"0178", uint8(13), PARENT, hex"0365746800"));
    }
}
