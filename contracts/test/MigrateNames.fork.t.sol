// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {SetupEnsCommit, SetupEnsRegister} from "../script/SetupEns.s.sol";
import {MigrateNames} from "../script/MigrateNames.s.sol";
import {CardVault} from "../src/CardVault.sol";
import {CardNames} from "../src/CardNames.sol";
import {IENSRegistryV2, IENSResolverV2} from "../src/interfaces/IENSv2.sol";
import {EnsRoles} from "../src/libraries/EnsRoles.sol";
import {ICardNames} from "../src/interfaces/ICardNames.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {EnsFork} from "./utils/EnsFork.sol";

interface ILegacyResolverView {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @dev Runs SetupEns and MigrateNames against the LIVE CardVault on a Sepolia fork. The only cheats: the vault's owner
/// slot is pointed at a throwaway key (so no real key is needed), `vm.warp` past the commitment age, and `vm.roll` to
/// end the live auction before settling it. Output JSON goes to a git-ignored directory.
contract MigrateNamesForkTest is EnsFork {
    using stdStorage for StdStorage;
    using Strings for uint256;

    string constant DIR = "deployments/tmp/migrate-fork";
    string constant LABEL = "kuramigratefork";
    CardVault constant VAULT = CardVault(0x62FB23ec64994F658E9DD4E0FC223DdF8a7D62c2);
    CardNames constant OLD_NAMES = CardNames(0xF963277C91F88048d893E17d56b293a9c7f04014);

    address deployer;
    uint256 deployerPk;
    address signer = makeAddr("signer");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"));
        (deployer, deployerPk) = makeAddrAndKey("migrate-deployer");
        vm.etch(deployer, "");
        vm.etch(bob, "");
        stdstore.target(address(VAULT)).sig("owner()").checked_write(deployer);
        assertEq(VAULT.owner(), deployer);

        vm.createDir(DIR, true);
        vm.copyFile("deployments/sepolia.json", string.concat(DIR, "/sepolia.json"));
        vm.setEnv("KURA_DEPLOYMENTS_DIR", DIR);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(deployerPk));
        vm.setEnv("VAULT_ENS_LABEL", LABEL);
        vm.setEnv("SIGNER_ADDRESS", vm.toString(signer));
        vm.setEnv("KURA_NEW_CARD_NAMES", vm.toString(address(0)));

        new SetupEnsCommit().run();
        vm.warp(block.timestamp + 61);
        new SetupEnsRegister().run();
    }

    function _live(uint256 id) internal view returns (bool) {
        CardVault.State s = VAULT.cards(id).state;
        return s != CardVault.State.None && s != CardVault.State.Released;
    }

    function _t(CardNames names, string memory label, string memory key) internal view returns (string memory) {
        return _urText(names.dnsOf(label), names.nodeOf(label), key);
    }

    function _old(string memory label, string memory key) internal view returns (string memory) {
        return ILegacyResolverView(address(OLD_NAMES.resolver())).text(OLD_NAMES.nodeOf(label), key);
    }

    function test_migratesEveryLiveCardAndStaysInSync() public {
        CardNames names = new MigrateNames().run();

        // wiring
        assertEq(address(VAULT.names()), address(names), "vault points at the new adapter");
        assertEq(names.vault(), address(VAULT), "adapter points at the vault");
        assertEq(names.vendor(), OLD_NAMES.vendor());
        assertEq(names.appraiser(), OLD_NAMES.appraiser());
        string memory dep = vm.readFile(string.concat(DIR, "/sepolia.json"));
        assertEq(vm.parseJsonAddress(dep, ".cardNames"), address(names));
        assertEq(vm.parseJsonAddress(dep, ".ensRegistry"), address(names.registry()));
        assertEq(vm.parseJsonAddress(dep, ".ensResolver"), address(names.resolver()));
        assertEq(vm.parseJsonBytes32(dep, ".ensParentNode"), names.parentNode());
        assertEq(vm.parseJsonAddress(dep, ".cardVault"), address(VAULT), "other keys untouched");

        uint256 last = VAULT.nextId() - 1;
        uint256 migrated;
        for (uint256 id = 1; id <= last; id++) {
            CardVault.Card memory c = VAULT.cards(id);
            if (!_live(id)) {
                assertEq(names.cardLabels(id), "", "released cards are not migrated");
                assertTrue(names.isAvailable(c.label));
                continue;
            }
            migrated++;
            string memory l = c.label;
            assertEq(names.cardLabels(id), l);
            assertEq(_urResolver(names.dnsOf(l)), address(names.resolver()), "UR finds the new resolver");
            assertEq(_urAddr(names.dnsOf(l), names.nodeOf(l)), c.beneficialOwner, "addr = beneficial owner");
            assertEq(_t(names, l, "scryfall"), c.scryfallId);
            assertEq(_t(names, l, "language"), c.language);
            assertEq(_t(names, l, "url"), string.concat(VAULT.siteURI(), id.toString()));
            assertEq(_t(names, l, "avatar"), _old(l, "avatar"));
            assertEq(_t(names, l, "description"), _old(l, "description"));
            assertEq(_t(names, l, "condition"), _old(l, "condition"));
            assertEq(_t(names, l, "vault.state"), _old(l, "vault.state"), "state matches what the vault wrote");
            assertEq(_t(names, l, "vault.shards"), _old(l, "vault.shards"));
            assertEq(_t(names, l, "vault.auction"), _old(l, "vault.auction"));
            assertEq(_t(names, l, "vault.clearing_usdc"), _old(l, "vault.clearing_usdc"));
            if (c.state == CardVault.State.Sharded) {
                assertEq(
                    _t(names, l, "vault.clearing_usdc"),
                    PriceMath.q96ToUsdcPerShard(VAULT.shardings(c.shardToken).clearingPriceQ96).toString()
                );
            }
        }
        assertGt(migrated, 0);

        // a second run changes nothing: no new adapter, no record writes
        vm.recordLogs();
        CardNames again = new MigrateNames().run();
        assertEq(address(again), address(names), "rerun reuses the adapter");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != IENSResolverV2.TextUpdated.selector, "rerun wrote a text record");
            assertTrue(logs[i].topics[0] != IENSResolverV2.AddressUpdated.selector, "rerun wrote an address record");
        }

        _vaultStillDrivesNames(names, last);
    }

    /// @dev An interrupted broadcast: the adapter is deployed, recorded in sepolia.json, granted its roles, has one card
    /// registered with stale records, and already points at the vault, but the vault was never switched. A rerun must
    /// reuse it, stand in as the vault again for the missing cards, and finish.
    function test_resumesAfterPartialRun() public {
        string memory ens = vm.readFile(string.concat(DIR, "/sepolia.ens.json"));
        IENSRegistryV2 registry = IENSRegistryV2(vm.parseJsonAddress(ens, ".registry"));
        IENSResolverV2 resolver = IENSResolverV2(vm.parseJsonAddress(ens, ".resolver"));
        vm.startPrank(deployer);
        CardNames halfDone = new CardNames(
            CardNames.Config({
                owner: deployer,
                vault: deployer,
                registry: address(registry),
                resolver: address(resolver),
                factory: vm.parseJsonAddress(ens, ".verifiableFactory"),
                resolverImpl: vm.parseJsonAddress(ens, ".resolverImpl"),
                parentLabel: LABEL,
                vendor: OLD_NAMES.vendor(),
                appraiser: OLD_NAMES.appraiser()
            })
        );
        registry.grantRootRoles(EnsRoles.CARD_NAMES_REGISTRY_ROLES, address(halfDone));
        resolver.grantRootRoles(EnsRoles.CARD_NAMES_RESOLVER_ROLES, address(halfDone));
        CardVault.Card memory two = VAULT.cards(2);
        halfDone.registerCard(2, two.label, deployer, ICardNames.CardRecords("", "", "", "", "", ""));
        halfDone.setVault(address(VAULT));
        vm.stopPrank();
        vm.writeJson(
            string.concat('"', vm.toString(address(halfDone)), '"'), string.concat(DIR, "/sepolia.json"), ".cardNames"
        );

        CardNames names = new MigrateNames().run();
        assertEq(address(names), address(halfDone), "resumed on the recorded adapter");
        assertEq(address(VAULT.names()), address(halfDone));
        assertEq(halfDone.vault(), address(VAULT));
        for (uint256 id = 1; id < VAULT.nextId(); id++) {
            if (!_live(id)) continue;
            CardVault.Card memory c = VAULT.cards(id);
            assertEq(halfDone.cardLabels(id), c.label);
            assertEq(_urAddr(halfDone.dnsOf(c.label), halfDone.nodeOf(c.label)), c.beneficialOwner);
            assertEq(_t(halfDone, c.label, "vault.state"), _old(c.label, "vault.state"));
            assertEq(_t(halfDone, c.label, "avatar"), _old(c.label, "avatar"));
            assertEq(_t(halfDone, c.label, "scryfall"), c.scryfallId);
        }
    }

    /// @dev After the switch, live vault calls update the new names: settle an auctioning card, move a whole one.
    function _vaultStillDrivesNames(CardNames names, uint256 last) internal {
        bool settled;
        bool moved;
        for (uint256 id = 1; id <= last; id++) {
            CardVault.Card memory c = VAULT.cards(id);
            if (!settled && c.state == CardVault.State.Auctioning) {
                if (block.number < c.endBlock) vm.roll(c.endBlock);
                VAULT.settle(id);
                assertEq(_t(names, c.label, "vault.state"), "sharded", "settle updated the new name");
                assertEq(
                    _t(names, c.label, "vault.clearing_usdc"),
                    PriceMath.q96ToUsdcPerShard(VAULT.shardings(c.shardToken).clearingPriceQ96).toString()
                );
                settled = true;
            } else if (!moved && c.state == CardVault.State.Whole) {
                address holder = VAULT.ownerOf(id);
                vm.prank(holder);
                VAULT.transferFrom(holder, bob, id);
                assertEq(_urAddr(names.dnsOf(c.label), names.nodeOf(c.label)), bob, "transfer updated the addr");
                moved = true;
            }
        }
        assertTrue(settled || moved, "no live card to exercise");
    }
}
