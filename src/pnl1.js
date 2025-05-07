/**
 * Calculate a trader's PnL and score based on a swap transaction on Solana.
 *
 * @param {Object} transaction           - Swap transaction object
 * @param {string} transaction.signature - Transaction signature
 * @param {number|undefined} transaction.blockTime - Unix timestamp of block (optional)
 * @param {Array<Object>} transaction.accountData - Array of account balance changes
 * @param {string} transaction.type      - Transaction type (e.g. "SWAP")
 * @param {string} transaction.source    - Transaction source (e.g. "PUMP_AMM")
 * @param {string|null} transaction.transactionError - Error string, or null
 * @param {string} userAccount           - The user's wallet public key
 * @param {Object} [priceMap={}]         - Mapping from token mint to price in SOL
 * @returns {{ signature: string,
*            blockTime: number|undefined,
*            pnlInSol: number,
*            score: number,
*            isGoodTrader: boolean }}
*/

const data = require("./data")

const LAMPORTS_PER_SOL = 1e9;

function calculateSwapPnLScore(
 transaction,
 userAccount,
 priceMap = {}
) {
 const { signature, blockTime, accountData: txTrasnfers } = transaction;
 let nativeLamports = 0;
 let tokenProfitSol = 0;
 let totalVolumeSol = 0;

 txTrasnfers.forEach(entry => {
   // Native SOL changes
   if (entry.account === userAccount && typeof entry.nativeBalanceChange === 'number') {
     nativeLamports += entry.nativeBalanceChange;
     totalVolumeSol += Math.abs(entry.nativeBalanceChange) / LAMPORTS_PER_SOL;
   }

   // SPL token changes
   if (Array.isArray(entry.tokenBalanceChanges)) {
     entry.tokenBalanceChanges.forEach(change => {
       if (change.userAccount !== userAccount) return;

       const raw = Number(change.rawTokenAmount.tokenAmount);
       const dec = change.rawTokenAmount.decimals;
       const amount = raw / Math.pow(10, dec);
       const mint = change.mint;
       const priceSol = priceMap[mint] || 0;
       const profitSol = amount * priceSol;
       tokenProfitSol += profitSol;
       totalVolumeSol += Math.abs(amount * priceSol);
     });
   }
 });

 const pnlNativeSol = nativeLamports / LAMPORTS_PER_SOL;
 const pnlInSol = pnlNativeSol + tokenProfitSol;

 // Score: 0–100 via tanh of return ratio
 let score = 0;
 if (totalVolumeSol > 0) {
   const ratio = pnlInSol / totalVolumeSol;
   score = Math.tanh(ratio) * 100;
 }
 score = Math.max(0, Math.min(100, score));

 return {
   signature,
   blockTime,
   pnlInSol,
   score,
   isGoodTrader: score >= 50
 };
}

// Export
module.exports = { calculateSwapPnLScore };

// Example:
// const tx = { signature: "...", blockTime: 1234567890, accountData: [...], type: "SWAP", source: "PUMP_AMM", transactionError: null };
// const { calculateSwapPnLScore } = require('./traderScore');
// const result = calculateSwapPnLScore(tx, '9JGuVmjXTeMea6VY6fpsu8783YeJME8bewyy9qv9UBxh', {
//   'So11111111111111111111111111111111111111112': 1,
//   'GkCfs9n8jLvuviiToewryCFa2rHQGKQv9FdnhTUEJtCH': 0.75
// });
// console.log(result);





  // (()=>{
  //   console.log("Testing the first 5 transactions (or fewer if data is shorter):");
  //   const numToTest = Math.min(5, data.length);
  //   for (let i = 0; i < numToTest; i++) {
  //     const it = data[i];
  //     const signer = 'DWHeyiEeZabGJAVTdQefd92qUvSot64uhX7xEX3ME2Ng';
  //     // if (!it || !it.signer) {
  //     //   console.log(`Skipping transaction at index ${i} due to missing data or signer.`, it);
  //     //   continue;
  //     // }
  //     console.log(`\nProcessing transaction ${i + 1} with signature: ${it.signature}`);
  //     console.log(`Signer: ${signer}`);
  //     const p = calculateSwapPnLScore(it, signer, {
  //       'So11111111111111111111111111111111111111112': 1, // SOL price in SOL is 1
  //     });
  //     console.log("Calculated PnL and Score:", p);
  //     if (p.score !== null && p.score !== undefined && !isNaN(p.score)) {
  //       console.log(`Validation: Score for transaction ${i+1} is ${p.score}, which is a number.`);
  //     } else {
  //       console.log(`Validation: Score for transaction ${i+1} is NOT a meaningful number: ${p.score}`);
  //     }
  //   }
  // })();
