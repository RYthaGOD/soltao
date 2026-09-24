// The return bundle (stake/return.js): everything the Bittensor -> Solana direction needs that the
// forward page does not, chiefly polkadot's api. app.js loads it only when someone opens the return
// direction, so the forward page never downloads it. It hands its functions to app.js on a global,
// because both bundles are classic scripts under `script-src 'self'`.

import { finishFreeReturn } from "./return_route.js";
import { quoteReturn, planReturnFunding, MIN_RETURN_RAO, RETURN_GAS_LIMIT, WEI_PER_RAO } from "./oft_return.js";
import { quoteTransfer, freeBalance, stakePositions, alphaPriceRao, subnetDirectory, disconnectApi } from "./substrate.js";
import { runStakeMove, limitPrice } from "./stake_moves.js";

globalThis.__soltaoReturn = { finishFreeReturn, quoteReturn, planReturnFunding, quoteTransfer, freeBalance, stakePositions, alphaPriceRao, subnetDirectory, runStakeMove, limitPrice, disconnectApi, MIN_RETURN_RAO, RETURN_GAS_LIMIT, WEI_PER_RAO };
