// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {CardVault} from "../src/CardVault.sol";
import {BidGateHook} from "../src/BidGateHook.sol";
import {CardNames} from "../src/CardNames.sol";
import {ShardMarket} from "../src/ShardMarket.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IENSRegistryV2, IENSResolverV2} from "../src/interfaces/IENSv2.sol";
import {EnsRoles} from "../src/libraries/EnsRoles.sol";
import {EnsEnv} from "./SetupEns.s.sol";

contract Deploy is EnsEnv {
    address constant CCA_FACTORY = 0x000000001F26a0044BaA66024e7b6599c61963F8;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    // Uniswap v4 on Sepolia
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant POSITION_MANAGER = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    address constant UNIVERSAL_ROUTER = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b;
    address constant STATE_VIEW = 0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C;
    address constant V4_QUOTER = 0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227;
    /// @dev Forge routes a salted `new` inside a broadcast through this deterministic deployer.
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant MARKET_FLAGS =
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;

    /// @dev Mirrors CardVault.MAX_FEE_BPS (src/CardVault.sol). Solidity has no way to read a public constant off
    /// another contract's type without a deployed instance, so this is kept in sync by hand; the vault's own
    /// constructor enforces the same bound as a backstop.
    uint16 constant MAX_VENDOR_FEE_BPS = 1000;

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
        require(block.chainid == 11155111, "Deploy targets Sepolia only");

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
        ShardMarket market = _deployMarket(address(vault));
        vault.setMarket(address(market));
        names.setVault(address(vault));
        IENSRegistryV2(c.registry).grantRootRoles(EnsRoles.CARD_NAMES_REGISTRY_ROLES, address(names));
        IENSResolverV2(c.resolver).grantRootRoles(EnsRoles.CARD_NAMES_RESOLVER_ROLES, address(names));
        vm.stopBroadcast();

        _write(c, address(vault), address(hook), address(names), address(market));

        console2.log("CardVault", address(vault));
        console2.log("ShardMarket", address(market));
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
        uint256 feeBps = vm.envUint("VENDOR_FEE_BPS");
        require(feeBps <= MAX_VENDOR_FEE_BPS, "VENDOR_FEE_BPS exceeds CardVault.MAX_FEE_BPS");
        return new CardVault(
            CardVault.Config({
                owner: c.deployer,
                vendor: c.vendor,
                feeBps: uint16(feeBps),
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

    /// @dev The market is the pool hook, so its address must carry its permission flags: mine a CREATE2 salt for them.
    function _deployMarket(address vault) internal returns (ShardMarket market) {
        bytes memory args = abi.encode(POOL_MANAGER, POSITION_MANAGER, PERMIT2, vault, USDC);
        (address mined, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, MARKET_FLAGS, type(ShardMarket).creationCode, args);
        market = new ShardMarket{salt: salt}(
            IPoolManager(POOL_MANAGER), IPositionManager(POSITION_MANAGER), IAllowanceTransfer(PERMIT2), vault, USDC
        );
        require(address(market) == mined, "ShardMarket address does not match the mined hook address");
    }

    function _write(Ctx memory c, address vault, address hook, address names, address market) internal {
        string memory json = "deployments";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "deployBlock", block.number);
        vm.serializeAddress(json, "cardVault", vault);
        vm.serializeAddress(json, "bidGateHook", hook);
        vm.serializeAddress(json, "cardNames", names);
        vm.serializeAddress(json, "usdc", USDC);
        vm.serializeAddress(json, "permit2", PERMIT2);
        vm.serializeAddress(json, "ccaFactory", CCA_FACTORY);
        vm.serializeAddress(json, "shardMarket", market);
        vm.serializeAddress(json, "poolManager", POOL_MANAGER);
        vm.serializeAddress(json, "positionManager", POSITION_MANAGER);
        vm.serializeAddress(json, "universalRouter", UNIVERSAL_ROUTER);
        vm.serializeAddress(json, "stateView", STATE_VIEW);
        vm.serializeAddress(json, "v4Quoter", V4_QUOTER);
        vm.serializeAddress(json, "ensRegistry", c.registry);
        vm.serializeAddress(json, "ensResolver", c.resolver);
        vm.serializeString(json, "ensParentLabel", c.label);
        vm.serializeBytes32(json, "ensParentNode", c.parentNode);
        vm.serializeAddress(json, "signer", c.signer);
        string memory out = vm.serializeAddress(json, "vendor", c.vendor);
        vm.writeJson(out, string.concat(deploymentsDir(), "/sepolia.json"));
    }
}
