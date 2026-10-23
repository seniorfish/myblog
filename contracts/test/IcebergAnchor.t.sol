// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IcebergAnchor} from "../src/IcebergAnchor.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool, address) external;
}

contract IcebergAnchorTest {
    Vm private constant VM = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    event Anchored(address indexed sender, bytes32 indexed commit);

    IcebergAnchor private anchor;

    function setUp() public {
        anchor = new IcebergAnchor();
    }

    function testEventTopicMatchesIndexer() public pure {
        require(
            keccak256("Anchored(address,bytes32)") ==
                0xee1610244dfc4b116b1433dd4459fd7b1d3d2bf737a05fc3f6d8f173005d7147,
            "event topic drifted"
        );
    }

    function testAnchorEmitsSenderAndCommit() public {
        bytes32 commit = bytes32(uint256(0x1234));
        VM.expectEmit(true, true, false, true, address(anchor));
        emit Anchored(address(this), commit);
        anchor.anchor(commit);
    }

    function testAnchorsAreIndependent() public {
        anchor.anchor(bytes32(uint256(1)));
        anchor.anchor(bytes32(uint256(2)));
    }
}
