// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IETHRegistrar, IVerifiableFactory, IENSRegistryV2, IENSResolverV2} from "../src/interfaces/IENSv2.sol";
import {EnsRoles} from "../src/libraries/EnsRoles.sol";
import {DnsName} from "../src/libraries/DnsName.sol";

interface IMintableToken {
    function mint(address to, uint256 amount) external;
}

/// ENSv2 Sepolia addresses. Defaults come from ensdomains/contracts-v2 at commit 48b3e2d,
/// contracts/deployments/sepolia/{ETHRegistry,ETHRegistrar,VerifiableFactory,UserRegistryImpl,PermissionedResolverImpl,
/// MockUSDC}.json, checked on chain (RootRegistry.getSubregistry("eth") returns this ETHRegistry, and this
/// ETHRegistrar's ETH_REGISTRY() returns it too). The older docs addresses belong to a superseded deployment whose
/// registry hangs off a retired root. Each default can be overridden with an env var.
abstract contract EnsEnv is Script {
    function ethRegistry() internal view returns (address) {
        return vm.envOr("ENS_ETH_REGISTRY", address(0x67b728a792e789a8978b30cF1b3b641f19354b43));
    }

    function ethRegistrar() internal view returns (address) {
        return vm.envOr("ENS_ETH_REGISTRAR", address(0xa4449a0dD2b83007553D9b1d28b583A46A805a30));
    }

    function verifiableFactory() internal view returns (address) {
        return vm.envOr("ENS_VERIFIABLE_FACTORY", address(0x118Bc31A50d559F7015a8Da26d54B3b030CdB70F));
    }

    function userRegistryImpl() internal view returns (address) {
        return vm.envOr("ENS_USER_REGISTRY_IMPL", address(0x840Fa461059862Ea466A711E8C98c8dE732061C0));
    }

    function resolverImpl() internal view returns (address) {
        return vm.envOr("ENS_RESOLVER_IMPL", address(0x7E4B2d59938930168024201752EE5503df402303));
    }

    /// Registrar payment token: the repo's MockUSDC (6 decimals, free `mint`). The registrar above reverts
    /// `PaymentTokenNotSupported` for the docs' 0x16f9... token, which only the superseded registrar accepts.
    function feeToken() internal view returns (address) {
        return vm.envOr("ENS_FEE_TOKEN", address(0xD3322B29a7BdEe707D1684676f149bf41Aa3422f));
    }

    /// Output directory for deployment JSON, relative to contracts/. Overridable so fork tests never overwrite the real
    /// deployment files.
    function deploymentsDir() internal view returns (string memory) {
        return vm.envOr("KURA_DEPLOYMENTS_DIR", string("deployments"));
    }

    uint64 internal constant DURATION = 365 days; // registrar minimum is 28 days
}

/// Phase 1: deploy the vault's subname registry and shared resolver, fund the registrar fee, commit to the name.
contract SetupEnsCommit is EnsEnv {
    function run() external {
        require(block.chainid == 11155111, "Deploy targets Sepolia only");

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        require(deployer.code.length == 0, "deployer must be a plain EOA (no EIP-7702 delegation)");
        string memory label = vm.envString("VAULT_ENS_LABEL");
        IETHRegistrar registrar = IETHRegistrar(ethRegistrar());
        require(
            registrar.isAvailable(label), "label not available: set VAULT_ENS_LABEL to a free label such as kuravault"
        );

        vm.startBroadcast(pk);
        IVerifiableFactory factory = IVerifiableFactory(verifiableFactory());
        address registry = factory.deployProxy(
            userRegistryImpl(),
            uint256(keccak256(abi.encode("kura.registry.v1", label))),
            abi.encodeCall(IENSRegistryV2.initialize, (deployer, EnsRoles.ALL_ROLES))
        );
        address resolver = factory.deployProxy(
            resolverImpl(),
            uint256(keccak256(abi.encode("kura.resolver.v1", label))),
            abi.encodeCall(IENSResolverV2.initialize, (deployer, EnsRoles.ALL_ROLES, new bytes[](0)))
        );

        address token = feeToken();
        (uint256 base, uint256 premium) = registrar.getRegisterPrice(label, DURATION, token);
        uint256 price = base + premium;
        if (IERC20(token).balanceOf(deployer) < price) {
            IMintableToken(token).mint(deployer, price);
        }
        IERC20(token).approve(address(registrar), price);

        bytes32 secret = keccak256(abi.encode("kura-commit", label, block.timestamp, deployer));
        bytes32 commitment = registrar.makeCommitment(label, deployer, secret, registry, resolver, DURATION, bytes32(0));
        registrar.commit(commitment);
        vm.stopBroadcast();

        string memory json = "ens-pending";
        vm.serializeString(json, "label", label);
        vm.serializeAddress(json, "registry", registry);
        vm.serializeAddress(json, "resolver", resolver);
        vm.serializeAddress(json, "feeToken", token);
        vm.serializeBytes32(json, "secret", secret);
        string memory out = vm.serializeUint(json, "duration", DURATION);
        vm.writeJson(out, string.concat(deploymentsDir(), "/sepolia.ens.pending.json"));

        console2.log("registry", registry);
        console2.log("resolver", resolver);
        console2.log("committed; wait this many seconds before SetupEnsRegister:", registrar.MIN_COMMITMENT_AGE());
    }
}

/// Phase 2: reveal and register the name, link the registry as its parent, name the appraiser agent.
contract SetupEnsRegister is EnsEnv {
    function run() external {
        require(block.chainid == 11155111, "Deploy targets Sepolia only");

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        require(deployer.code.length == 0, "deployer must be a plain EOA (no EIP-7702 delegation)");
        address signer = vm.envAddress("SIGNER_ADDRESS");
        string memory pending = vm.readFile(string.concat(deploymentsDir(), "/sepolia.ens.pending.json"));
        string memory label = vm.parseJsonString(pending, ".label");
        address registry = vm.parseJsonAddress(pending, ".registry");
        address resolver = vm.parseJsonAddress(pending, ".resolver");
        address token = vm.parseJsonAddress(pending, ".feeToken");
        bytes32 secret = vm.parseJsonBytes32(pending, ".secret");
        uint64 duration = uint64(vm.parseJsonUint(pending, ".duration"));

        vm.startBroadcast(pk);
        IETHRegistrar(ethRegistrar()).register(label, deployer, secret, registry, resolver, duration, token, bytes32(0));
        IENSRegistryV2(registry).setParent(ethRegistry(), label);

        // appraiser agent namespace: appraiser.<label>.eth -> backend signer
        IENSRegistryV2(registry)
            .register(
                "appraiser",
                deployer,
                address(0),
                resolver,
                EnsRoles.COLLECTOR_TOKEN_ROLES,
                uint64(block.timestamp) + 3650 days
            );
        bytes32 parentNode = DnsName.node(DnsName.ETH_NODE, label);
        bytes32 appraiserNode = DnsName.node(parentNode, "appraiser");
        IENSResolverV2(resolver).setAddr(appraiserNode, signer);
        IENSResolverV2(resolver)
            .setText(appraiserNode, "description", "Kura appraisal agent: signs market appraisals used for buyouts");
        vm.stopBroadcast();

        string memory json = "ens";
        vm.serializeString(json, "label", label);
        vm.serializeAddress(json, "registry", registry);
        vm.serializeAddress(json, "resolver", resolver);
        vm.serializeAddress(json, "verifiableFactory", verifiableFactory());
        vm.serializeAddress(json, "resolverImpl", resolverImpl());
        vm.serializeBytes32(json, "parentNode", parentNode);
        string memory out = vm.serializeAddress(json, "appraiserAddr", signer);
        vm.writeJson(out, string.concat(deploymentsDir(), "/sepolia.ens.json"));
        console2.log("registered", label);
    }
}
