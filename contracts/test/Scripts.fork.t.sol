// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SetupEnsCommit, SetupEnsRegister} from "../script/SetupEns.s.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Seed} from "../script/Seed.s.sol";
import {CardVault} from "../src/CardVault.sol";
import {CardNames} from "../src/CardNames.sol";
import {IENSRegistryV2} from "../src/interfaces/IENSv2.sol";
import {DnsName} from "../src/libraries/DnsName.sol";
import {ShardMarket} from "../src/ShardMarket.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {EnsFork} from "./utils/EnsFork.sol";

interface IETHRegistryView {
    function findOwner(string calldata label) external view returns (address);
    function getSubregistry(string calldata label) external view returns (address);
}

/// @dev Runs the four deployment scripts in order on a Sepolia fork. The only cheats are the ones a dry run cannot do:
/// `vm.warp` past the registrar's commitment age, and clearing any EIP-7702 delegation that a public test key may
/// carry on Sepolia. Output JSON goes to a git-ignored directory, never to the real deployment files.
contract ScriptsForkTest is EnsFork {
    string constant DIR = "deployments/tmp/fork-test";
    string constant LABEL = "kurascriptfork";
    uint160 constant MARKET_FLAGS =
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;

    address deployer;
    uint256 deployerPk;
    address vendor;
    uint256 vendorPk;
    address signer = makeAddr("signer");
    address payout = makeAddr("payout");
    address demoOwner = makeAddr("demoOwner");

    function setUp() public {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"));
        (deployer, deployerPk) = makeAddrAndKey("script-deployer");
        (vendor, vendorPk) = makeAddrAndKey("script-vendor");
        vm.etch(deployer, "");
        vm.etch(vendor, "");
        vm.etch(demoOwner, "");
        vm.createDir(DIR, true);
        vm.setEnv("KURA_DEPLOYMENTS_DIR", DIR);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(deployerPk));
        vm.setEnv("VENDOR_PRIVATE_KEY", vm.toString(vendorPk));
        vm.setEnv("VAULT_ENS_LABEL", LABEL);
        vm.setEnv("SIGNER_ADDRESS", vm.toString(signer));
        vm.setEnv("VENDOR_ADDRESS", vm.toString(vendor));
        vm.setEnv("VENDOR_PAYOUT_ADDRESS", vm.toString(payout));
        vm.setEnv("VENDOR_FEE_BPS", "250");
        vm.setEnv("BASE_URI", "https://kura.example/api/meta/");
        vm.setEnv("SITE_URI", "https://kura.example/app/cards/");
        vm.setEnv("DEMO_OWNER", vm.toString(demoOwner));
    }

    function test_fullDeploymentSequence() public {
        new SetupEnsCommit().run();
        vm.warp(block.timestamp + 61);
        vm.roll(block.number + 5);
        new SetupEnsRegister().run();
        new Deploy().run();
        new Seed().run();

        string memory dep = vm.readFile(string.concat(DIR, "/sepolia.json"));
        CardVault vault = CardVault(vm.parseJsonAddress(dep, ".cardVault"));
        CardNames names = CardNames(vm.parseJsonAddress(dep, ".cardNames"));
        IENSRegistryV2 registry = IENSRegistryV2(vm.parseJsonAddress(dep, ".ensRegistry"));
        address resolver = vm.parseJsonAddress(dep, ".ensResolver");
        bytes32 parentNode = vm.parseJsonBytes32(dep, ".ensParentNode");

        // <label>.eth registered to the deployer with the vault's registry as subregistry
        IETHRegistryView eth = IETHRegistryView(ENS_ETH_REGISTRY);
        assertEq(eth.findOwner(LABEL), deployer, "eth owner");
        assertEq(eth.getSubregistry(LABEL), address(registry), "subregistry");
        assertEq(parentNode, DnsName.node(DnsName.ETH_NODE, LABEL));
        assertEq(vm.parseJsonUint(dep, ".chainId"), 11155111);
        assertEq(vm.parseJsonString(dep, ".ensParentLabel"), LABEL);

        // brief Step 6 on-chain checks
        assertEq(vault.vendor(), vendor, "vault vendor");
        assertEq(registry.findOwner("appraiser"), deployer, "appraiser owner");
        bytes memory appraiserDns = DnsName.addLabel("appraiser", DnsName.ethName(LABEL));
        assertEq(_urAddr(appraiserDns, DnsName.node(parentNode, "appraiser")), signer, "appraiser addr");
        assertEq(_urResolver(DnsName.ethName(LABEL)), resolver, "parent resolves to the shared resolver");
        assertEq(registry.findOwner("black-lotus-lea-1"), address(names), "card name owner");

        // shard market: mined hook address, wired into the vault, pointed at Sepolia v4
        ShardMarket market = ShardMarket(vm.parseJsonAddress(dep, ".shardMarket"));
        assertEq(address(vault.market()), address(market));
        assertEq(uint160(address(market)) & Hooks.ALL_HOOK_MASK, MARKET_FLAGS, "hook flags in the address");
        assertEq(market.vault(), address(vault));
        assertEq(market.usdc(), vm.parseJsonAddress(dep, ".usdc"));
        assertEq(address(market.poolManager()), vm.parseJsonAddress(dep, ".poolManager"));
        assertEq(address(market.positionManager()), vm.parseJsonAddress(dep, ".positionManager"));
        assertEq(address(market.permit2()), vm.parseJsonAddress(dep, ".permit2"));
        assertEq(vm.parseJsonAddress(dep, ".poolManager"), 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
        assertEq(vm.parseJsonAddress(dep, ".positionManager"), 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4);
        assertEq(vm.parseJsonAddress(dep, ".universalRouter"), 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b);
        assertEq(vm.parseJsonAddress(dep, ".stateView"), 0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C);
        assertEq(vm.parseJsonAddress(dep, ".v4Quoter"), 0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227);

        // wiring
        assertEq(names.vault(), address(vault));
        assertEq(names.parentNode(), parentNode);
        assertEq(address(vault.names()), address(names));
        assertEq(vault.ownerOf(1), demoOwner);
        assertEq(vault.cards(1).label, "black-lotus-lea-1");
        string memory card = "black-lotus-lea-1";
        assertEq(_urText(names.dnsOf(card), names.nodeOf(card), "condition"), "LP");
        assertEq(_urText(names.dnsOf(card), names.nodeOf(card), "vault.state"), "whole");
        assertEq(_urAddr(names.dnsOf(card), names.nodeOf(card)), demoOwner, "card addr is its owner");

        string memory ens = vm.readFile(string.concat(DIR, "/sepolia.ens.json"));
        assertEq(vm.parseJsonAddress(ens, ".universalResolver"), ENS_UNIVERSAL_RESOLVER);
        assertEq(vm.parseJsonAddress(ens, ".ethRegistry"), ENS_ETH_REGISTRY);
        assertEq(vm.parseJsonAddress(ens, ".feeToken"), ENS_FEE_TOKEN);
    }
}
