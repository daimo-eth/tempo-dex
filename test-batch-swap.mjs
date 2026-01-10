// Test batched approve + swap using Tempo transaction format
import { createWalletClient, createPublicClient, http, encodeFunctionData, parseUnits, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';

const PRIVATE_KEY = '0xf22a74a1c6319e91c89b44cbff6e190d5993fc9cd305bd94b8bf407658786bd5';
const account = privateKeyToAccount(PRIVATE_KEY);

console.log('Wallet address:', account.address);

const publicClient = createPublicClient({
  chain: tempoModerato,
  transport: http(),
});

const walletClient = createWalletClient({
  account,
  chain: tempoModerato,
  transport: http(),
});

const DEX = '0xdec0000000000000000000000000000000000000';
const ALPHA = '0x20c0000000000000000000000000000000000001';
const PATH = '0x20c0000000000000000000000000000000000000';

const DEX_ABI = [
  {
    name: 'swapExactAmountIn',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'tokenIn' },
      { type: 'address', name: 'tokenOut' },
      { type: 'uint128', name: 'amountIn' },
      { type: 'uint128', name: 'minAmountOut' },
    ],
    outputs: [{ type: 'uint128', name: 'amountOut' }],
  },
];

async function test() {
  try {
    const amountIn = parseUnits('1', 6);
    const minAmountOut = parseUnits('0.99', 6);
    
    console.log('Testing batched approve + swap...');
    console.log('  tokenIn:', ALPHA);
    console.log('  tokenOut:', PATH);
    console.log('  amountIn:', amountIn.toString());
    console.log('  minAmountOut:', minAmountOut.toString());
    
    // Build the calls array (approve + swap)
    const calls = [
      {
        to: ALPHA,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [DEX, amountIn],
        }),
      },
      {
        to: DEX,
        data: encodeFunctionData({
          abi: DEX_ABI,
          functionName: 'swapExactAmountIn',
          args: [ALPHA, PATH, amountIn, minAmountOut],
        }),
      },
    ];
    
    console.log('Sending batch transaction with', calls.length, 'calls...');
    
    // Send as Tempo batch transaction using the calls array
    const hash = await walletClient.sendTransaction({
      calls,
    });
    
    console.log('Batch tx hash:', hash);
    
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log('Receipt status:', receipt.status);
    
    if (receipt.status === 'success') {
      console.log('Batched swap succeeded!');
    } else {
      console.log('Batched swap REVERTED');
    }
  } catch (e) {
    console.error('Error:', e.message);
    if (e.cause) console.error('Cause:', e.cause);
  }
}

test();
