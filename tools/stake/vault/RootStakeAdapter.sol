// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// PROTOTYPE ONLY: privileged adapter, no shares, bridge authentication or user redemption.
// Not approved for deployment or deposits.
interface IRootStaking {
    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable;
    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable;
    function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) external view returns (uint256);
}
interface IAddressMapping { function addressMapping(address who) external view returns (bytes32); }

contract RootStakeAdapter {
    address public immutable owner;
    bytes32 public immutable hotkey;
    address constant STAKING = address(0x805);
    error Unauthorized();
    error PayoutFailed();
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    constructor(address owner_, bytes32 hotkey_) {
        require(owner_ != address(0) && hotkey_ != bytes32(0), "invalid configuration");
        owner = owner_; hotkey = hotkey_;
    }
    function stake(uint256 rao) external onlyOwner { IRootStaking(STAKING).addStake(hotkey, rao, 0); }
    function unstake(uint256 rao) external onlyOwner { IRootStaking(STAKING).removeStake(hotkey, rao, 0); }
    function claim() external onlyOwner {
        // Bulk caller claim uses the runtime's coldkey-wide admission budget. In runtime 482,
        // the selected-validator path can reject a large basket with RootClaimTooHeavy.
        (bool ok, bytes memory reason) = STAKING.call(abi.encodeWithSignature("claimRoot(uint16[])", new uint16[](0)));
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
    }
    function unclaimed() external view returns (uint256 value) {
        (bool ok, bytes memory data) = STAKING.staticcall(abi.encodeWithSignature(
            "getUnclaimedRootTaoByHotkey(bytes32,bytes32)", coldkey(), hotkey));
        require(ok && data.length == 32, "reward view unavailable");
        return abi.decode(data, (uint256));
    }
    function coldkey() public view returns (bytes32) { return IAddressMapping(address(0x80c)).addressMapping(address(this)); }
    function staked() external view returns (uint256) { return IRootStaking(STAKING).getStake(hotkey, coldkey(), 0); }
    function payout(address payable recipient, uint256 weiAmount) external onlyOwner {
        (bool ok,) = recipient.call{value: weiAmount}("");
        if (!ok) revert PayoutFailed();
    }
    receive() external payable {}
}
