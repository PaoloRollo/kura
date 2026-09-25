// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IValidationHook} from "@cca/interfaces/IValidationHook.sol";
import {TicketVerifier} from "./TicketVerifier.sol";
import {Tickets} from "./libraries/Tickets.sol";

/// @notice Uniswap CCA validation hook: every bid must carry a backend-signed World ID HUMAN ticket for the bidding
/// wallet, and each World ID nullifier is bound to the first wallet that bids with it. One human, one bidding wallet.
contract BidGateHook is IValidationHook, IERC165, TicketVerifier, Ownable {
    mapping(uint256 nullifier => address wallet) public nullifierOwner;

    event BidderBound(uint256 indexed nullifier, address indexed wallet);

    error WrongKind();
    error WrongSubject();
    error AlreadyBound(address boundTo);

    constructor(address signer_, address owner_) TicketVerifier("Kura BidGate", signer_) Ownable(owner_) {}

    /// @notice Rotate the backend signer.
    function setSigner(address s) external onlyOwner {
        _setSigner(s);
    }

    /// @inheritdoc IValidationHook
    /// @dev `sender` is the auction's msg.sender (the bidder); `owner` is the bid beneficiary. Both must equal the ticket subject.
    function validate(uint256, uint128, address owner, address sender, bytes calldata hookData) external override {
        (Tickets.Ticket memory t, bytes memory sig) = abi.decode(hookData, (Tickets.Ticket, bytes));
        if (t.kind != Tickets.KIND_HUMAN) revert WrongKind();
        if (t.subject != sender || owner != sender) revert WrongSubject();
        _verifyTicket(t, sig);

        address bound = nullifierOwner[t.nullifier];
        if (bound == address(0)) {
            nullifierOwner[t.nullifier] = sender;
            emit BidderBound(t.nullifier, sender);
        } else if (bound != sender) {
            revert AlreadyBound(bound);
        }
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IValidationHook).interfaceId;
    }
}
