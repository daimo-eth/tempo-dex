import { createWalletClient, createPublicClient, http, encodeFunctionData, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY = '0xf22a74a1c6319e91c89b44cbff6e190d5993fc9cd305bd94b8bf407658786bd5';
const account = privateKeyToAccount(PRIVATE_KEY);

console.log('Wallet address:', account.address);

const tempoModerato = {
  id: 42431,
  name: 'Tempo Moderato',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 6 },
  rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } },
};

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
const BETA = '0x20c0000000000000000000000000000000000002';
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
  {
    name: 'quoteSwapExactAmountIn',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { type: 'address', name: 'tokenIn' },
      { type: 'address', name: 'tokenOut' },
      { type: 'uint128', name: 'amountIn' },
    ],
    outputs: [{ type: 'uint128', name: 'amountOut' }],
  },
];

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { type: 'address', name: 'owner' },
      { type: 'address', name: 'spender' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'spender' },
      { type: 'uint256', name: 'amount' },
    ],
    outputs: [{ type: 'bool' }],
  },
];

async function test() {
  try {
    // Check balances
    const betaBalance = await publicClient.readContract({
      address: BETA,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    });
    console.log('BetaUSD balance:', betaBalance.toString());

    const pathBalance = await publicClient.readContract({
      address: PATH,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    });
    console.log('PathUSD balance:', pathBalance.toString());

    // Check allowance
    const allowance = await publicClient.readContract({
      address: BETA,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, DEX],
    });
    console.log('BetaUSD allowance to DEX:', allowance.toString());

    // Get quote for small swap
    const amountIn = parseUnits('1', 6); // 1 BetaUSD
    const quote = await publicClient.readContract({
      address: DEX,
      abi: DEX_ABI,
      functionName: 'quoteSwapExactAmountIn',
      args: [BETA, PATH, amountIn],
    });
    console.log('Quote for 1 BetaUSD -> PathUSD:', quote.toString());

    // Approve if needed
    if (allowance < amountIn) {
      console.log('Approving DEX to spend BetaUSD...');
      const approveTx = await walletClient.writeContract({
        address: BETA,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [DEX, amountIn * 1000n], // Approve more for future swaps
      });
      console.log('Approve tx:', approveTx);
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
      console.log('Approval confirmed');
    }

    // Execute swap
    const minAmountOut = (quote * 99n) / 100n; // 1% slippage
    console.log('Executing swap: 1 BetaUSD -> PathUSD, minOut:', minAmountOut.toString());
    
    const swapTx = await walletClient.writeContract({
      address: DEX,
      abi: DEX_ABI,
      functionName: 'swapExactAmountIn',
      args: [BETA, PATH, amountIn, minAmountOut],
    });
    console.log('Swap tx:', swapTx);
    
    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapTx });
    console.log('Swap receipt status:', receipt.status);
    console.log('Swap succeeded!');

  } catch (e) {
    console.error('Error:', e.message);
    if (e.cause) console.error('Cause:', e.cause);
  }
}

test();
