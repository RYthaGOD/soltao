import { ethers } from "ethers";
import {
  MIN_RETURN_RAO, encodeQuoteSend, encodeOftSend, decodeMessagingFee,
  quoteReturn, planReturnFunding, raoToWei, removeReturnDust, solanaLdFromWei,
} from "../src/oft_return.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const TO = `0x${"42".repeat(32)}`;
const REFUND = "0x1234567890abcdef1234567890abcdef12345678";
const AMOUNT = 1_234_567_890_000_000_000n;
const MIN = 1_234_567_000_000_000_000n;
const NATIVE_FEE = 3_280_000_000_000_000n;

const iface = new ethers.Interface([
  "function quoteSend(tuple(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam,bool payInLzToken) view returns (tuple(uint256 nativeFee,uint256 lzTokenFee))",
  "function send(tuple(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam,tuple(uint256 nativeFee,uint256 lzTokenFee) fee,address refundAddress) payable",
]);
const param = [30168, TO, AMOUNT, MIN, "0x", "0x", "0x"];

expect("quoteSend calldata matches an independent ABI encoder",
  encodeQuoteSend({ to: TO, amountLd: AMOUNT, minAmountLd: MIN }) === iface.encodeFunctionData("quoteSend", [param, false]));
expect("send calldata matches an independent ABI encoder",
  encodeOftSend({ to: TO, amountLd: AMOUNT, minAmountLd: MIN, nativeFee: NATIVE_FEE, refundAddress: REFUND }) ===
    iface.encodeFunctionData("send", [param, [NATIVE_FEE, 0n], REFUND]));

const rawFee = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(uint256 nativeFee,uint256 lzTokenFee)"], [[NATIVE_FEE, 0n]]);
const decoded = decodeMessagingFee(rawFee);
expect("messaging fee response decodes both fee assets", decoded.nativeFee === NATIVE_FEE && decoded.lzTokenFee === 0n);

const rawRao = 1_234_567_890n;
const cleanWei = removeReturnDust(raoToWei(rawRao));
expect("18-decimal wTAO floors to the OFT's 6 shared decimals", cleanWei === 1_234_567_000_000_000_000n);
expect("the destination reconstructs the matching 9-decimal Solana amount", solanaLdFromWei(cleanWei) === 1_234_567_000n);
expect("the smallest return is exactly one shared unit", MIN_RETURN_RAO === 1_000n);

const cleanPlan = planReturnFunding({ amountRao: 1_000_000_000n, nativeFeeWei: NATIVE_FEE, gasPriceWei: 5_000_000_000n });
expect("a clean return funds the wrapped amount, LayerZero fee, and gas reserve",
  cleanPlan.fundingRao === 1_007_630_000n && cleanPlan.wrapWei === 1_000_000_000_000_000_000n,
  `${cleanPlan.fundingRao} rao`);
const resumedPlan = planReturnFunding({
  amountRao: 1_000_000_000n, nativeFeeWei: NATIVE_FEE, gasPriceWei: 5_000_000_000n,
  transitNativeWei: 4_000_000_000_000_000n, transitWtaoWei: 400_000_000_000_000_000n,
});
expect("return planning reuses recoverable native TAO and wTAO already on transit",
  resumedPlan.fundingRao === 603_630_000n && resumedPlan.existingWtaoUsed === 400_000_000_000_000_000n && resumedPlan.leftoverWtaoWei === 0n,
  `${resumedPlan.fundingRao} rao still needed`);
expect("rao funding rounds upward without losing wei", resumedPlan.fundingRao * 1_000_000_000n >= resumedPlan.fundingWei && resumedPlan.fundingOverageWei < 1_000_000_000n);
const wrappedPlan = planReturnFunding({ amountRao: 1_000_000_000n, nativeFeeWei: NATIVE_FEE, gasPriceWei: 5_000_000_000n, transitWtaoWei: 1_000_000_000_000_000_000n });
expect("an already-wrapped return does not reserve wrap gas again", wrappedPlan.wrapWei === 0n && wrappedPlan.gasReserveWei === 3_900_000_000_000_000n);

let rejected = false;
try { await quoteReturn({ amountRao: 999n, solanaRecipient: TO }); } catch (e) { rejected = /0\.000001 TAO/.test(e.message); }
expect("sub-shared-decimal returns are rejected before an RPC call", rejected);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
