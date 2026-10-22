// Read-only eth_call. The harness creates the adapter with its actual constructor inside the call.
// No transactions, signing, state persistence or funded deployment.
import solc from "solc";
import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const adapter = readFileSync(new URL("../vault/RootStakeAdapter.sol",import.meta.url),"utf8");
const harness = readFileSync(new URL("./VaultCapability.sol",import.meta.url),"utf8");
const output=JSON.parse(solc.compile(JSON.stringify({language:"Solidity",sources:{
  "RootStakeAdapter.sol":{content:adapter},"VaultCapability.sol":{content:harness}},
  settings:{optimizer:{enabled:true,runs:200},evmVersion:"paris",outputSelection:{"*":{"*":["abi","evm.deployedBytecode.object"]}}}})));
const errors=(output.errors??[]).filter(e=>e.severity==="error");
if(errors.length)throw Error(errors.map(e=>e.formattedMessage).join("\n"));
const artifact=output.contracts["VaultCapability.sol"].VaultCapability;
const iface=new ethers.Interface(artifact.abi);
const RPC="https://lite.chain.opentensor.ai";
async function rpc(method,params){
  const response=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error(`RPC HTTP ${response.status}`);
  const body=await response.json(); if(body.error)throw Error(body.error.message);return body.result;
}
const head=await rpc("chain_getFinalizedHead",[]);
const header=await rpc("chain_getHeader",[head]);
const block=ethers.toQuantity(BigInt(header.number));
const version=await rpc("state_getRuntimeVersion",[head]);
const probe="0x7777777777777777777777777777777777777777";
const hotkey="0x20b0f8ac1d5416d32f5a552f98b570f06e8392ccb803029e04f63fbe0553c954";
const claimGas=BigInt(process.env.VAULT_CLAIM_GAS || "100000000");
const data=iface.encodeFunctionData("run",[hotkey,100_000_000n,claimGas]);
const encoded=await rpc("eth_call",[{from:"0x134f59E8B8637FD70ae12f263492B1dc73A25D1e",to:probe,
  value:ethers.toQuantity(200_000_000_000_000_000n),data,gas:ethers.toQuantity(BigInt(process.env.VAULT_PROBE_GAS || "150000000"))},block,
  {[probe]:{code:"0x"+artifact.evm.deployedBytecode.object}}]);
const [r]=iface.decodeFunctionResult("run",encoded);
assert.ok(r.staked>0n);assert.ok(r.remainingStake<=10n);assert.ok(r.recoveredWei>190_000_000_000_000_000n);
assert.equal(r.unauthorizedBlocked,true);
const report={kind:"read-only-contract-capability",blockHash:head,blockNumber:BigInt(header.number).toString(),
  runtimeVersion:version.specVersion,compiler:solc.version(),adapterSourceHash:ethers.id(adapter),
  coldkey:r.coldkey,stakeRao:r.staked.toString(),remainingStakeRao:r.remainingStake.toString(),
  recoveredWei:r.recoveredWei.toString(),unauthorizedBlocked:r.unauthorizedBlocked,
  rewardViewAvailable:r.rewardView,claimCallAccepted:r.claimAccepted,claimStakeDeltaRao:r.claimStakeDelta.toString(),
  claimGasUsed:r.claimGasUsed.toString(),claimGasAllowance:claimGas.toString(),simulationGasLimit:process.env.VAULT_PROBE_GAS || "150000000",
  claimMethod:"claimRoot(uint16[])",claimSubnets:[],
  productionReady:false,paidClaimProven:false,
  claimFailure:r.claimFailure,
  limitations:["State override harness; adapter created inside eth_call, never deployed persistently.",
    "Fresh stake earns no rewards inside a single call: claim acceptance does not prove a paid claim.",
    "Privileged prototype only: no share token, bridge verification, full vault accounting or production review."]};
console.log(JSON.stringify(report,null,2));
if(process.argv.includes("--save"))writeFileSync(new URL("../../../docs/vault-capability-2026-10-22.json",import.meta.url),JSON.stringify(report,null,2)+"\n");
if(!r.rewardView || !r.claimAccepted) {
  console.error("INCOMPLETE: required reward read/claim capability not established; do not deploy this vault.");
  process.exitCode=2;
}
