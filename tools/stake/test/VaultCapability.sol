// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "RootStakeAdapter.sol";

contract UntrustedCaller {
    function attempt(address target, bytes calldata data) external returns (bool, bytes memory) {
        return target.call(data);
    }
    receive() external payable {}
}
contract VaultCapability {
    function assertDenied(UntrustedCaller stranger, address target, bytes memory data) private {
        (bool ok, bytes memory reason) = stranger.attempt(target, data);
        require(!ok && bytes4(reason) == RootStakeAdapter.Unauthorized.selector, "unauthorized call accepted");
    }
    struct Result {
        bytes32 coldkey;
        uint256 staked;
        uint256 remainingStake;
        uint256 recoveredWei;
        bool rewardView;
        bool claimAccepted;
        uint256 claimStakeDelta;
        bool unauthorizedBlocked;
        uint256 claimGasUsed;
        bytes claimFailure;
    }
    function run(bytes32 hotkey, uint256 rao, uint256 claimGas) external payable returns (Result memory r) {
        RootStakeAdapter vault = new RootStakeAdapter(address(this), hotkey);
        UntrustedCaller stranger = new UntrustedCaller();
        (bool funded,) = address(vault).call{value: msg.value}(""); require(funded, "funding failed");
        r.coldkey = vault.coldkey();
        vault.stake(rao); r.staked = vault.staked(); require(r.staked > 0, "no stake");
        (bool viewed,) = address(vault).staticcall(abi.encodeCall(vault.unclaimed,()));
        r.rewardView = viewed;
        uint256 beforeGas = gasleft();
        (r.claimAccepted, r.claimFailure) = address(vault).call{gas: claimGas}(abi.encodeCall(vault.claim,()));
        r.claimGasUsed = beforeGas-gasleft();
        uint256 afterClaim = vault.staked();
        r.claimStakeDelta = afterClaim > r.staked ? afterClaim-r.staked : 0;
        assertDenied(stranger,address(vault),abi.encodeCall(vault.payout,(payable(address(stranger)),1)));
        assertDenied(stranger,address(vault),abi.encodeCall(vault.unstake,(1)));
        assertDenied(stranger,address(vault),abi.encodeCall(vault.stake,(1)));
        assertDenied(stranger,address(vault),abi.encodeCall(vault.claim,()));
        r.unauthorizedBlocked = true;
        vault.unstake(afterClaim); r.remainingStake = vault.staked();
        uint256 available = address(vault).balance;
        uint256 before = address(this).balance;
        vault.payout(payable(address(this)), available);
        r.recoveredWei = address(this).balance-before;
    }
    receive() external payable {}
}
