// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Test-only. Never deployed. test/mainnet.test.mjs places this code on Bittensor EVM mainnet
// addresses inside a single eth_call (a state override), so nothing is sent and nothing changes.

struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

interface IOFT {
    function lzReceive(Origin calldata, bytes32, bytes calldata, address, bytes calldata) external payable;
}

/// Placed at the LayerZero endpoint's address, so the real wTAO OFT accepts its lzReceive. Delivers
/// a plain send from Solana to the transit account, forwards the executor's gas drop, has the
/// transit account replay the page's transactions in order, then answers one read.
contract Endpoint {
    address constant WTAO = 0x134f59E8B8637FD70ae12f263492B1dc73A25D1e;
    bytes32 constant SOLANA_PEER = 0x75a92f08bec255fbad197fdd879ce8497830c94d5122e54b38dafb9b9253718f;

    function replay(
        address transit,
        uint64 amountSD,
        address[] calldata to,
        uint256[] calldata value,
        bytes[] calldata data,
        address readTo,
        bytes calldata readData
    ) external payable returns (bool[] memory ok, uint256[] memory gasUsed, bytes memory read, uint256 transitBalance) {
        _deliver(transit, amountSD);
        (ok, gasUsed) = Transit(payable(transit)).run(to, value, data);
        read = _read(readTo, readData);
        transitBalance = transit.balance;
    }

    function _deliver(address transit, uint64 amountSD) private {
        if (msg.value > 0) {
            (bool dropped, ) = payable(transit).call{value: msg.value}("");
            require(dropped, "gas drop failed");
        }
        if (amountSD == 0) return;
        // The OFT message for a send with no compose: recipient, then amount in shared decimals.
        bytes memory message = abi.encodePacked(bytes32(uint256(uint160(transit))), amountSD);
        IOFT(WTAO).lzReceive(Origin(30168, SOLANA_PEER, 1), keccak256(message), message, address(0xdead), "");
    }

    function _read(address readTo, bytes calldata readData) private view returns (bytes memory out) {
        if (readTo == address(0)) return out;
        bool r;
        (r, out) = readTo.staticcall(readData);
        require(r, "read failed");
    }
}

/// Placed at the transit account's own address, so every replayed call reaches wTAO and the
/// precompiles with msg.sender == transit, exactly as the page's signed transactions do. A failed
/// call is recorded and the rest still run, as later transactions from a real account would.
contract Transit {
    function run(address[] calldata to, uint256[] calldata value, bytes[] calldata data)
        external
        returns (bool[] memory ok, uint256[] memory gasUsed)
    {
        ok = new bool[](to.length);
        gasUsed = new uint256[](to.length);
        for (uint256 i = 0; i < to.length; i++) {
            uint256 g = gasleft();
            (ok[i], ) = to[i].call{value: value[i]}(data[i]);
            gasUsed[i] = g - gasleft();
        }
    }

    receive() external payable {}
}
