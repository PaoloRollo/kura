// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {SetupEnsCommit, SetupEnsRegister} from "../script/SetupEns.s.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Seed} from "../script/Seed.s.sol";
import {CardVault} from "../src/CardVault.sol";
import {CardNames} from "../src/CardNames.sol";
import {IENSRegistryV2, IENSResolverV2} from "../src/interfaces/IENSv2.sol";
import {DnsName} from "../src/libraries/DnsName.sol";

interface IETHRegistryView {
    function findOwner(string calldata label) external view returns (address);
    function getSubregistry(string calldata label) external view returns (address);
}

/// @dev Runs the four deployment scripts in order on a Sepolia fork. The only cheats are the ones a dry run cannot do:
/// `vm.warp` past the registrar's commitment age, and clearing any EIP-7702 delegation that a public test key may
/// carry on Sepolia. Output JSON goes to a git-ignored directory, never to the real deployment files.
contract ScriptsForkTest is Test {
    string constant DIR = "deployments/tmp/fork-test";
    string constant LABEL = "kurascriptfork";

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
        IENSResolverV2 resolver = IENSResolverV2(vm.parseJsonAddress(dep, ".ensResolver"));
        bytes32 parentNode = vm.parseJsonBytes32(dep, ".ensParentNode");

        // <label>.eth registered to the deployer with the vault's registry as subregistry
        IETHRegistryView eth = IETHRegistryView(0x67b728a792e789a8978b30cF1b3b641f19354b43);
        assertEq(eth.findOwner(LABEL), deployer, "eth owner");
        assertEq(eth.getSubregistry(LABEL), address(registry), "subregistry");
        assertEq(parentNode, DnsName.node(DnsName.ETH_NODE, LABEL));
        assertEq(vm.parseJsonUint(dep, ".chainId"), 11155111);
        assertEq(vm.parseJsonString(dep, ".ensParentLabel"), LABEL);

        // brief Step 6 on-chain checks
        assertEq(vault.vendor(), vendor, "vault vendor");
        assertEq(registry.findOwner("appraiser"), deployer, "appraiser owner");
        assertEq(resolver.addr(DnsName.node(parentNode, "appraiser")), signer, "appraiser addr");
        assertEq(registry.findOwner("black-lotus-lea-1"), address(names), "card name owner");

        // wiring
        assertEq(names.vault(), address(vault));
        assertEq(names.parentNode(), parentNode);
        assertEq(address(vault.names()), address(names));
        assertEq(vault.ownerOf(1), demoOwner);
        assertEq(vault.cards(1).label, "black-lotus-lea-1");
        assertEq(resolver.text(names.nodeOf("black-lotus-lea-1"), "condition"), "LP");
    }
}
