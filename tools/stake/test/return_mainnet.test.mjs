// Zero-cost mainnet-state replay of wrap + canonical wTAO OFT send to Solana.
import solc from "solc";
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RETURN_GAS_LIMIT, encodeOftSend } from "../src/oft_return.js";

const RPC = process.env.BITTENSOR_EVM_RPC || "https://lite.chain.opentensor.ai";
const PROBE = "0x7777777777777777777777777777777777777777";
const WTAO = "0x134f59E8B8637FD70ae12f263492B1dc73A25D1e";
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "ReturnReplay.sol"), "utf8");
const output = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity", sources: { "ReturnReplay.sol": { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.deployedBytecode.object"] } } },
})));
const errors = (output.errors || []).filter((error) => error.severity === "error");
if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join("\n"));
const artifact = output.contracts["ReturnReplay.sol"].ReturnReplay;
const iface = new ethers.Interface(artifact.abi);
const data = iface.encodeFunctionData("run", [`0x${"42".repeat(32)}`, 1_000_000_000_000_000_000n]);

const response = await fetch(RPC, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [
    { from: WTAO, to: PROBE, data, value: ethers.toQuantity(2_000_000_000_000_000_000n), gas: ethers.toQuantity(30_000_000n) }, "latest",
    { [PROBE]: { code: `0x${artifact.evm.deployedBytecode.object}` } },
  ] }),
});
const body = await response.json();
if (body.error) throw new Error(body.error.message);
const [stage, nativeFee, wrapGas, sendGas, wtaoLeft, failure] = iface.decodeFunctionResult("run", body.result);
if (stage !== 4n) throw new Error(`live return replay stopped at stage ${stage}: ${failure}`);
if (nativeFee <= 0n) throw new Error("LayerZero returned no native fee");
if (wtaoLeft !== 0n) throw new Error(`OFT send left ${wtaoLeft} wTAO behind`);
const intrinsicGas = (hex) => 21_000n + [...Buffer.from(hex.replace(/^0x/, ""), "hex")].reduce((gas, byte) => gas + (byte === 0 ? 4n : 16n), 0n);
const wrapTotalGas = wrapGas + intrinsicGas("0xd0e30db0");
const sendData = encodeOftSend({ to: `0x${"42".repeat(32)}`, amountLd: 1_000_000_000_000_000_000n, nativeFee, refundAddress: PROBE });
const sendTotalGas = sendGas + intrinsicGas(sendData);
if (wrapTotalGas > RETURN_GAS_LIMIT.wrap) throw new Error(`wrap needs ${wrapTotalGas} total gas, above ${RETURN_GAS_LIMIT.wrap}`);
if (sendTotalGas > RETURN_GAS_LIMIT.send) throw new Error(`send needs ${sendTotalGas} total gas, above ${RETURN_GAS_LIMIT.send}`);
console.log(`PASS  real wTAO wraps 1 TAO and sends it toward Solana inside a zero-cost mainnet eth_call`);
console.log(`PASS  live fee ${(Number(nativeFee) / 1e18).toFixed(9)} TAO · wrap ${wrapTotalGas}/${RETURN_GAS_LIMIT.wrap} total gas · send ${sendTotalGas}/${RETURN_GAS_LIMIT.send} total gas · 0 wTAO left`);
