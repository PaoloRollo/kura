// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {CardVault} from "../src/CardVault.sol";
import {BidGateHook} from "../src/BidGateHook.sol";
import {CardNames} from "../src/CardNames.sol";
import {IENSRegistryV2, IENSResolverV2} from "../src/interfaces/IENSv2.sol";
import {EnsRoles} from "../src/libraries/EnsRoles.sol";
import {EnsEnv} from "./SetupEns.s.sol";

contract Deploy is EnsEnv {
    address constant CCA_FACTORY = 0x000000001F26a0044BaA66024e7b6599c61963F8;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    struct Ctx {
        uint256 pk;
        address deployer;
        address signer;
        address vendor;
        string label;
        address registry;
        address resolver;
        bytes32 parentNode;
    }

    function run() external {
        Ctx memory c;
        c.pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.deployer = vm.addr(c.pk);
        require(c.deployer.code.length == 0, "deployer must be a plain EOA (no EIP-7702 delegation)");
        c.signer = vm.envAddress("SIGNER_ADDRESS");
        c.vendor = vm.envAddress("VENDOR_ADDRESS");

        string memory ens = vm.readFile(string.concat(deploymentsDir(), "/sepolia.ens.json"));
        c.label = vm.parseJsonString(ens, ".label");
        c.registry = vm.parseJsonAddress(ens, ".registry");
        c.resolver = vm.parseJsonAddress(ens, ".resolver");
        c.parentNode = vm.parseJsonBytes32(ens, ".parentNode");

        vm.startBroadcast(c.pk);
        BidGateHook hook = new BidGateHook(c.signer, c.deployer);
        CardNames names = _deployNames(c, ens);
        CardVault vault = _deployVault(c, address(hook), address(names));
        names.setVault(address(vault));
        IENSRegistryV2(c.registry).grantRootRoles(EnsRoles.CARD_NAMES_REGISTRY_ROLES, address(names));
        IENSResolverV2(c.resolver).grantRootRoles(EnsRoles.CARD_NAMES_RESOLVER_ROLES, address(names));
        vm.stopBroadcast();

        _write(c, address(vault), address(hook), address(names));

        console2.log("CardVault", address(vault));
        console2.log("BidGateHook", address(hook));
        console2.log("CardNames", address(names));
    }

    function _deployNames(Ctx memory c, string memory ens) internal returns (CardNames) {
        return new CardNames(
            CardNames.Config({
                owner: c.deployer,
                vault: address(0),
                registry: c.registry,
                resolver: c.resolver,
                factory: vm.parseJsonAddress(ens, ".verifiableFactory"),
                resolverImpl: vm.parseJsonAddress(ens, ".resolverImpl"),
                parentLabel: c.label,
                vendor: c.vendor,
                appraiser: c.signer
            })
        );
    }

    function _deployVault(Ctx memory c, address hook, address names) internal returns (CardVault) {
        return new CardVault(
            CardVault.Config({
                owner: c.deployer,
                vendor: c.vendor,
                feeBps: uint16(vm.envUint("VENDOR_FEE_BPS")),
                payout: vm.envAddress("VENDOR_PAYOUT_ADDRESS"),
                signer: c.signer,
                usdc: USDC,
                ccaFactory: CCA_FACTORY,
                hook: hook,
                names: names,
                baseURI: vm.envString("BASE_URI"),
                siteURI: vm.envString("SITE_URI")
            })
        );
    }

    function _write(Ctx memory c, address vault, address hook, address names) internal {
        string memory json = "deployments";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "deployBlock", block.number);
        vm.serializeAddress(json, "cardVault", vault);
        vm.serializeAddress(json, "bidGateHook", hook);
        vm.serializeAddress(json, "cardNames", names);
        vm.serializeAddress(json, "usdc", USDC);
        vm.serializeAddress(json, "permit2", PERMIT2);
        vm.serializeAddress(json, "ccaFactory", CCA_FACTORY);
        vm.serializeAddress(json, "ensRegistry", c.registry);
        vm.serializeAddress(json, "ensResolver", c.resolver);
        vm.serializeString(json, "ensParentLabel", c.label);
        vm.serializeBytes32(json, "ensParentNode", c.parentNode);
        vm.serializeAddress(json, "signer", c.signer);
        string memory out = vm.serializeAddress(json, "vendor", c.vendor);
        vm.writeJson(out, string.concat(deploymentsDir(), "/sepolia.json"));
    }
}
