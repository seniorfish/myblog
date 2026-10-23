// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IcebergAnchor} from "../src/IcebergAnchor.sol";

interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract Deploy {
    Vm private constant VM = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function run() external returns (IcebergAnchor anchor) {
        VM.startBroadcast();
        anchor = new IcebergAnchor();
        VM.stopBroadcast();
    }
}
