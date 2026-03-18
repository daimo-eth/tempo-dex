// Test tempo.ts sell action directly
import { createConfig, http } from '@wagmi/core';
import { Actions } from '@wagmi/core/tempo';
import { tempoModerato } from 'viem/chains';
import { parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY = '0xf22a74a1c6319e91c89b44cbff6e190d5993fc9cd305bd94b8bf407658786bd5';
const account = privateKeyToAccount(PRIVATE_KEY);

console.log('Testing tempo.ts sell action with wallet:', account.address);

const config = createConfig({
  chains: [tempoModerato],
  transports: {
    [tempoModerato.id]: http(),
  },
});

const BETA = '0x20c0000000000000000000000000000000000002';
const PATH = '0x20c0000000000000000000000000000000000000';

async function test() {
  try {
    const amountIn = parseUnits('1', 6);
    const minAmountOut = parseUnits('0.99', 6);
    
    console.log('Calling Actions.dex.sellSync...');
    console.log('  tokenIn:', BETA);
    console.log('  tokenOut:', PATH);
    console.log('  amountIn:', amountIn.toString());
    console.log('  minAmountOut:', minAmountOut.toString());
    
    const result = await Actions.dex.sellSync(config, {
      account,
      tokenIn: BETA,
      tokenOut: PATH,
      amountIn,
      minAmountOut,
    });
    
    console.log('Success! Result:', result);
  } catch (e) {
    console.error('Error:', e.message);
    if (e.cause) console.error('Cause:', e.cause);
    console.error('Full error:', e);
  }
}

test();
