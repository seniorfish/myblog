// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Event-only anchor registry. No storage, no owner, no upgradeability.
contract IcebergAnchor {
    event Anchored(address indexed sender, bytes32 indexed commit);

    function anchor(bytes32 commit) external {
        emit Anchored(msg.sender, commit);
    }
}
