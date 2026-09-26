// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IETHRegistrar, IResolverProfiles, IUniversalResolverV2} from "../../src/interfaces/IENSv2.sol";

interface IMintableErc20 {
    function mint(address to, uint256 amount) external;
}

/// @dev The ENSv2 Sepolia deployment on docs.ens.domains/learn/deployments: ensdomains/contracts-v2 at 71a3b73,
/// contracts/docs/addresses/sepolia.md. Each default can be overridden with the same ENS_* env var the scripts read.
abstract contract EnsFork is Test {
    address internal ENS_ROOT_REGISTRY = vm.envOr("ENS_ROOT_REGISTRY", address(0x9703DBD26dAB89504490994138cF2c575251a9cE));
    address internal ENS_ETH_REGISTRY = vm.envOr("ENS_ETH_REGISTRY", address(0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E));
    address internal ENS_ETH_REGISTRAR = vm.envOr("ENS_ETH_REGISTRAR", address(0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca));
    address internal ENS_VERIFIABLE_FACTORY =
        vm.envOr("ENS_VERIFIABLE_FACTORY", address(0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C));
    address internal ENS_USER_REGISTRY_IMPL =
        vm.envOr("ENS_USER_REGISTRY_IMPL", address(0xA80338aAA8D23831cEa25E858D1774534aBb0263));
    address internal ENS_RESOLVER_IMPL = vm.envOr("ENS_RESOLVER_IMPL", address(0x14F09Fd05d4585759e54844DC9B00147131Cf243));
    address internal ENS_UNIVERSAL_RESOLVER =
        vm.envOr("ENS_UNIVERSAL_RESOLVER", address(0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3));
    address internal ENS_FEE_TOKEN = vm.envOr("ENS_FEE_TOKEN", address(0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e));

    /// @dev Register `label`.eth on the live ETHRegistrar to `owner` (commit, age the commitment, register), paying in
    /// the mintable MockUSDC. `owner` must accept ERC-1155 (a plain EOA does).
    function _registerEth(string memory label, address owner, address subregistry, address resolver) internal {
        IETHRegistrar registrar = IETHRegistrar(ENS_ETH_REGISTRAR);
        uint64 duration = 365 days;
        (uint256 base, uint256 premium) = registrar.getRegisterPrice(label, duration, ENS_FEE_TOKEN);
        IMintableErc20(ENS_FEE_TOKEN).mint(address(this), base + premium);
        IERC20(ENS_FEE_TOKEN).approve(address(registrar), base + premium);
        bytes32 secret = keccak256(abi.encode("ens-fork", label));
        registrar.commit(registrar.makeCommitment(label, owner, secret, subregistry, resolver, duration, bytes32(0)));
        vm.warp(block.timestamp + registrar.MIN_COMMITMENT_AGE() + 1);
        registrar.register(label, owner, secret, subregistry, resolver, duration, ENS_FEE_TOKEN, bytes32(0));
    }

    /// @dev `text(key)` of `dns` (DNS-encoded) through the live UniversalResolverV2; `node` is its namehash.
    function _urText(bytes memory dns, bytes32 node, string memory key) internal view returns (string memory) {
        (bytes memory res,) = IUniversalResolverV2(ENS_UNIVERSAL_RESOLVER)
            .resolve(dns, abi.encodeCall(IResolverProfiles.text, (node, key)));
        return abi.decode(res, (string));
    }

    /// @dev `addr()` of `dns` through the live UniversalResolverV2.
    function _urAddr(bytes memory dns, bytes32 node) internal view returns (address) {
        (bytes memory res,) =
            IUniversalResolverV2(ENS_UNIVERSAL_RESOLVER).resolve(dns, abi.encodeCall(IResolverProfiles.addr, (node)));
        return abi.decode(res, (address));
    }

    /// @dev The resolver UniversalResolverV2 finds for `dns`.
    function _urResolver(bytes memory dns) internal view returns (address resolver) {
        (resolver,,) = IUniversalResolverV2(ENS_UNIVERSAL_RESOLVER).findResolver(dns);
    }
}
