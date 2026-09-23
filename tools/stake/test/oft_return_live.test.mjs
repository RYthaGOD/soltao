// Read-only mainnet check for the exact canonical wTAO -> Solana quote calldata.
import { quoteReturn } from "../src/oft_return.js";

const recipient = `0x${"42".repeat(32)}`;
const quote = await quoteReturn({ amountRao: 1_000_000_000n, solanaRecipient: recipient });
if (quote.amountRao !== 1_000_000_000n || quote.solanaAmountLd !== 1_000_000_000n) throw new Error("one TAO did not preserve its destination amount");
if (quote.nativeFee <= 0n || quote.lzTokenFee !== 0n) throw new Error("unexpected LayerZero fee quote");
console.log(`PASS  live wTAO quote returns ${(Number(quote.nativeFee) / 1e18).toFixed(9)} TAO native fee for 1 TAO -> Solana`);
