// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {CardVault} from "../src/CardVault.sol";

/// Mints one demo card to DEMO_OWNER so the indexer and the app have data immediately after deployment.
/// Run with the vendor key. Sharding is done from the app by the owner's Privy wallet.
contract Seed is Script {
    function run() external {
        uint256 vendorPk = vm.envUint("VENDOR_PRIVATE_KEY");
        address demoOwner = vm.envAddress("DEMO_OWNER");
        string memory dir = vm.envOr("KURA_DEPLOYMENTS_DIR", string("deployments"));
        string memory dep = vm.readFile(string.concat(dir, "/sepolia.json"));
        CardVault vault = CardVault(vm.parseJsonAddress(dep, ".cardVault"));

        vm.startBroadcast(vendorPk);
        uint256 id = vault.mint(
            CardVault.MintInput({
                to: demoOwner,
                scryfallId: "bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd",
                slug: "black-lotus",
                setCode: "lea",
                condition: "LP",
                language: "en",
                imageUrl: "https://cards.scryfall.io/normal/front/b/d/bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd.jpg",
                description: "Black Lotus, Limited Edition Alpha"
            })
        );
        vm.stopBroadcast();
        console2.log("minted card", id, "label", vault.cards(id).label);
    }
}
