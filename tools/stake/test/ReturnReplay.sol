// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Test-only. Injected at a temporary address for one eth_call; never deployed and never changes state.
struct SendParam {
    uint32 dstEid;
    bytes32 to;
    uint256 amountLD;
    uint256 minAmountLD;
    bytes extraOptions;
    bytes composeMsg;
    bytes oftCmd;
}
struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }

interface IWTAO {
    function deposit() external payable;
    function balanceOf(address owner) external view returns (uint256);
    function quoteSend(SendParam calldata param, bool payInLzToken) external view returns (MessagingFee memory);
    function send(SendParam calldata param, MessagingFee calldata fee, address refundAddress) external payable;
}

contract ReturnReplay {
    IWTAO constant WTAO = IWTAO(0x134f59E8B8637FD70ae12f263492B1dc73A25D1e);

    function run(bytes32 solanaRecipient, uint256 amountWei)
        external
        payable
        returns (uint256 stage, uint256 nativeFee, uint256 wrapGas, uint256 sendGas, uint256 wtaoLeft, bytes memory failure)
    {
        SendParam memory param = SendParam(30168, solanaRecipient, amountWei, amountWei, "", "", "");
        MessagingFee memory fee = WTAO.quoteSend(param, false);
        require(fee.lzTokenFee == 0, "unexpected LZ token fee");

        uint256 beforeGas = gasleft();
        (bool wrapped, bytes memory wrapResult) = address(WTAO).call{value: amountWei}(abi.encodeWithSignature("deposit()"));
        wrapGas = beforeGas - gasleft();
        if (!wrapped) return (1, fee.nativeFee, wrapGas, 0, 0, wrapResult);
        uint256 wrappedBalance = WTAO.balanceOf(address(this));
        if (wrappedBalance != amountWei) return (2, fee.nativeFee, wrapGas, 0, wrappedBalance, "wrap amount mismatch");

        beforeGas = gasleft();
        (bool sent, bytes memory sendResult) = address(WTAO).call{value: fee.nativeFee}(
            abi.encodeCall(IWTAO.send, (param, fee, address(this)))
        );
        sendGas = beforeGas - gasleft();
        nativeFee = fee.nativeFee;
        wtaoLeft = WTAO.balanceOf(address(this));
        if (!sent) return (3, nativeFee, wrapGas, sendGas, wtaoLeft, sendResult);
        stage = 4;
    }

    receive() external payable {}
}
