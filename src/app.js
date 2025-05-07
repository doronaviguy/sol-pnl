#!/usr/bin/env node

/**
 * Calculate realized PnL for a specific SPL token mint across its holders,
 * based on Helius parsed transaction history. Uses FIFO matching per token pair
 * and Redis caching (TTL=10m) for API calls.
 *
 * PnL is calculated *per counter-currency* (e.g., PnL in SOL, PnL in USDC).
 *
 * Usage:
 *   npm install @solana/web3.js axios redis dotenv
 *   REDIS_URL=<redis://localhost:6379> \
 *   RPC_URL=<your_rpc> \
 *   MINT_ADDRESS=<mint> \
 *   HELIUS_API_KEY=<key> \
 *     node pnl_oracle_cached_fixed.js # Renamed for clarity
 */

const { Connection, PublicKey } = require("@solana/web3.js");
const axios = require("axios");
const { createClient } = require("redis");
const dotenv = require("dotenv");
dotenv.config();


const SOL = 'So11111111111111111111111111111111111111112';
// --- Redis setup ---
const redisClient = createClient({
    // Explicitly use database 6 as in the original script
    url: process.env.REDIS_URL ? `${process.env.REDIS_URL}/6` : "redis://localhost:6379/6",
});
redisClient.on("error", err => console.error("Redis Error", err));

// Helper: cached HTTP GET via Axios
async function cachedAxiosGet(fullUrl) {
    const key = `cache:${fullUrl}`;
    try {
        const cached = await redisClient.get(key);
        if (cached) {
            console.log(`🔄 [Cache HIT] ${fullUrl.substring(0, 80)}...`);
            return { data: JSON.parse(cached) };
        }
    } catch (err) {
        console.error(`Redis GET error for key ${key}:`, err);
        // Proceed to fetch if cache read fails
    }

    console.log(`🌐 [Fetch] ${fullUrl.substring(0, 80)}...`);
    try {
        const resp = await axios.get(fullUrl);
        try {
            // Cache successful fetches
            await redisClient.set(key, JSON.stringify(resp.data), { EX: 600 }); // 10 min TTL
        } catch (err) {
            console.error(`Redis SET error for key ${key}:`, err);
        }
        return resp;
    } catch (error) {
        console.error(`Axios GET error for ${fullUrl}:`, error.message);
        // Depending on the error, you might want to retry or return a default
        if (error.response) {
            console.error("Helius API Error Status:", error.response.status);
            console.error("Helius API Error Data:", JSON.stringify(error.response.data, null, 2));
        }
         // Rethrow or handle appropriately - returning null here might break downstream logic
        throw error;
    }
}

// --- Constants ---
const DEFAULT_RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;
const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

// --- Solana Connection ---
// Create a single connection instance to reuse
let connection;
function getConnection(rpcUrl = DEFAULT_RPC) {
    if (!connection) {
        connection = new Connection(rpcUrl, { commitment: "confirmed" });
    }
    return connection;
}


// 1. Fetch all non-zero holders of the *target* mint, with caching
async function fetchHolders(mintAddress, rpcUrl) {
    const cacheKey = `holdersV2:${mintAddress}:${rpcUrl}`; // Use a different key if format changes
    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            console.log(`🔄 [Cache HIT] holders for ${mintAddress}`);
            return JSON.parse(cached);
        }
    } catch (err) {
        console.error(`Redis GET error for key ${cacheKey}:`, err);
    }

    const conn = getConnection(rpcUrl);
    const accounts = await conn.getParsedProgramAccounts(
        TOKEN_PROGRAM_ID,
        {
            filters: [
                { dataSize: 165 }, // Standard token account size
                { memcmp: { offset: 0, bytes: mintAddress } }, // Filter by mint
            ],
        }
    );

    const balances = {};
    for (const { account } of accounts) {
        const { owner, tokenAmount } = account.data.parsed.info;
        const amt = tokenAmount.uiAmount || 0;
        // Ensure owner is a valid pubkey string (basic check)
        if (amt > 0 && typeof owner === 'string' && owner.length > 30) {
             balances[owner] = (balances[owner] || 0) + amt;
        } else if (amt > 0) {
            console.warn(`Skipping account with invalid owner: ${owner} for mint ${mintAddress}`);
        }
    }

    const result = Object.entries(balances).map(([owner, balance]) => ({ owner, balance }));

    try {
        await redisClient.set(cacheKey, JSON.stringify(result), { EX: 600 }); // 10 min TTL
    } catch (err) {
        console.error(`Redis SET error for key ${cacheKey}:`, err);
    }
    return result;
}

// 2. Fetch all parsed transactions for a holder (with relevant fields), page by page, caching each page
async function fetchParsedTxs(holder, apiKey) {
    const base = `https://api.helius.xyz/v0/addresses/${holder}/transactions`;
    let before = null;
    const allTxs = [];
    let pageCount = 0;
    const maxPages = 100; // Safety break to prevent infinite loops

    console.log(`   Fetching txs for ${holder}... (limit ${maxPages * 100} txs)`);

    while (pageCount < maxPages) {
        pageCount++;
        const params = new URLSearchParams({ "api-key": apiKey, limit: "100" });
        if (before) params.set("before", before);
        const fullUrl = `${base}?${params.toString()}`;

        try {
            const { data: page } = await cachedAxiosGet(fullUrl);
            if (!page || !page.length) break; // Check if page is null or empty

            allTxs.push(...page);
            // Ensure the last tx has a signature before trying to use it
            if (page[page.length - 1] && page[page.length - 1].signature) {
                 before = page[page.length - 1].signature;
            } else {
                 console.warn(`   Last transaction in page ${pageCount} missing signature, stopping pagination.`);
                 break; // Stop if signature is missing
            }

             if (page.length < 100) break; // Last page fetched

        } catch (error) {
            console.error(`   Error fetching page ${pageCount} for ${holder}: ${error.message}. Stopping.`);
            // Optionally break or continue based on error handling strategy
             break;
        }

    }
     console.log(`   Fetched ${allTxs.length} raw transactions over ${pageCount} page(s).`);

    const swaps = allTxs.filter(tx => tx.type === 'SWAP').map(tx => ({
      signature: tx.signature,
      blockTime: tx.blockTime,
      accountData: tx.accountData || [], // Ensure accountData is an array
      type: tx.type, // Keep type for better filtering
      source: tx.source, // Keep source for context
      transactionError: tx.transactionError // Important to skip failed txs
  }))
    // Only keep necessary fields to reduce memory usage
    return swaps;
}

// Helper: Get token decimals with caching
const decimalsCache = {};
async function getTokenDecimals(mintAddress, rpcUrl) {
    if (mintAddress === SOL_MINT_ADDRESS) {
        return SOL_DECIMALS;
    }
    if (decimalsCache[mintAddress]) {
        return decimalsCache[mintAddress];
    }

    const cacheKey = `decimals:${mintAddress}`;
    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
             console.log(`🔄 [Cache HIT] Decimals for ${mintAddress}`);
             const decimals = parseInt(cached, 10);
             decimalsCache[mintAddress] = decimals; // Update in-memory cache
             return decimals;
        }
    } catch(err) {
         console.error(`Redis GET error for key ${cacheKey}:`, err);
    }


    console.log(`🪙 Fetching decimals for ${mintAddress}`);
    try {
        const conn = getConnection(rpcUrl);
        const mintInfo = await conn.getParsedAccountInfo(new PublicKey(mintAddress));
        if (mintInfo?.value?.data?.parsed?.info?.decimals !== undefined) {
             const decimals = mintInfo.value.data.parsed.info.decimals;
             decimalsCache[mintAddress] = decimals;
             try {
                 await redisClient.set(cacheKey, decimals.toString(), { EX: 3600 * 24 }); // Cache for 1 day
             } catch(err) {
                 console.error(`Redis SET error for key ${cacheKey}:`, err);
             }
             return decimals;
        } else {
             console.warn(`   ⚠️ Could not fetch decimals for mint ${mintAddress}`);
             return null; // Indicate failure
        }
    } catch (error) {
         console.error(`   ❌ Error fetching decimals for ${mintAddress}: ${error.message}`);
         return null; // Indicate failure
    }
}



/**
 * Processes parsed Solana transactions to build trade events and calculate PnL-based scores for an owner.
 *
 * @param {Array<Object>} parsedTxs - An array of parsed transaction objects.
 * @param {string} owner - The public key of the owner whose trades are being analyzed.
 * @param {string} [ignoredMint=null] - An optional mint address to ignore in SPL token calculations.
 * @param {string} [rpcUrl=null] - The RPC URL (currently unused in this version as decimals are typically in tx data).
 * @returns {Object} An object containing sorted trade events and PnL scores per token.
 *                   - events: Array of 'buy'/'sell' trade events involving the owner and SOL.
 *                   - scores: Array of objects detailing PnL estimates and scores for each SPL token traded against SOL by the owner.
 */
function buildTradeEvents(parsedTxs, owner, ignoredMint = null, rpcUrl = null) {
    const events = [];
    const aggregatedTokenData = {}; // To calculate PnL and scores per token: { mint: { data... } }

    for (const tx of parsedTxs) {
        if (tx.transactionError) {
            // console.log(`Skipping transaction ${tx.signature} due to transaction error.`);
            continue;
        }

        const balanceDeltas = {}; // { mint: UIAmount }

        // 1. Calculate Native SOL change for the owner
        const ownerNativeAccountInfo = tx.accountData.find(ad => ad.account === owner);
        if (ownerNativeAccountInfo && typeof ownerNativeAccountInfo.nativeBalanceChange === 'number') {
            balanceDeltas[SOL_MINT_ADDRESS] = (balanceDeltas[SOL_MINT_ADDRESS] || 0) + (ownerNativeAccountInfo.nativeBalanceChange / Math.pow(10, SOL_DECIMALS));
        }

        // 2. Calculate SPL Token changes for the owner
        for (const ad of tx.accountData) {
            if (ad.tokenBalanceChanges && ad.tokenBalanceChanges.length > 0) {
                for (const tbc of ad.tokenBalanceChanges) {
                    if (tbc.userAccount === owner) {
                        const mint = tbc.mint;
                        if (mint === ignoredMint) continue;

                        const rawAmtStr = tbc.rawTokenAmount?.tokenAmount;
                        const decimals = tbc.rawTokenAmount?.decimals;

                        if (typeof rawAmtStr === 'string' && typeof decimals === 'number') {
                            try {
                                const rawAmt = BigInt(rawAmtStr);
                                const uiAmt = Number(rawAmt) / Math.pow(10, decimals);
                                balanceDeltas[mint] = (balanceDeltas[mint] || 0) + uiAmt;
                            } catch (e) {
                                console.warn(`   ⚠️ Error parsing token amount for mint ${mint} in tx ${tx.signature} for owner ${owner}: ${rawAmtStr}`, e);
                            }
                        }
                    }
                }
            }
        }

        // 3. Determine the nature of the trade (SOL vs SPL token for the owner)
        const solChangeForOwner = balanceDeltas[SOL_MINT_ADDRESS] || 0;
        const splMintsInvolved = Object.keys(balanceDeltas).filter(
            m => m !== SOL_MINT_ADDRESS && balanceDeltas[m] !== 0 // Ensure there's a non-zero change
        );

        let tradeEvent = null;

        if (splMintsInvolved.length === 1 && solChangeForOwner !== 0) {
            const splMint = splMintsInvolved[0];
            const splChangeForOwner = balanceDeltas[splMint];

            if (!aggregatedTokenData[splMint]) {
                aggregatedTokenData[splMint] = {
                    mint: splMint,
                    totalSolSpent: 0,
                    totalSplBought: 0,
                    totalSolReceived: 0,
                    totalSplSold: 0,
                    tradeCount: 0,
                };
            }
            const tokenAggData = aggregatedTokenData[splMint];

            if (solChangeForOwner < 0 && splChangeForOwner > 0) { // Owner spent SOL to buy SPL
                tradeEvent = {
                    type: 'buy',
                    mint: splMint,
                    amount: splChangeForOwner, // Amount of SPL token bought
                    counterMint: SOL_MINT_ADDRESS,
                    counterAmount: Math.abs(solChangeForOwner), // Amount of SOL spent
                    price: Math.abs(solChangeForOwner) / splChangeForOwner, // Price: SOL per SPL token
                    blockTime: tx.blockTime,
                    signature: tx.signature,
                    source: tx.source
                };
                tokenAggData.totalSolSpent += Math.abs(solChangeForOwner);
                tokenAggData.totalSplBought += splChangeForOwner;
            } else if (solChangeForOwner > 0 && splChangeForOwner < 0) { // Owner received SOL by selling SPL
                tradeEvent = {
                    type: 'sell',
                    mint: splMint,
                    amount: Math.abs(splChangeForOwner), // Amount of SPL token sold
                    counterMint: SOL_MINT_ADDRESS,
                    counterAmount: solChangeForOwner, // Amount of SOL received
                    price: solChangeForOwner / Math.abs(splChangeForOwner), // Price: SOL per SPL token
                    blockTime: tx.blockTime,
                    signature: tx.signature,
                    source: tx.source
                };
                tokenAggData.totalSolReceived += solChangeForOwner;
                tokenAggData.totalSplSold += Math.abs(splChangeForOwner);
            }

            if (tradeEvent) {
                 events.push(tradeEvent);
                 tokenAggData.tradeCount++;
            }
        }
        // Note: SPL-to-SPL swaps for the owner (where solChangeForOwner is near 0, for fees)
        // and splMintsInvolved.length is 2 would require additional logic here if needed.
    }

    // 4. Calculate final PnL scores based on aggregatedTokenData
    const finalScores = Object.values(aggregatedTokenData).map(data => {
        let realizedPnlSol = 0;
        // Score: 100 for profit, 0 for loss, 50 for break-even or undetermined (e.g., only buys)
        let pnlScore = 50;

        if (data.totalSplBought > 0 && data.totalSplSold > 0) {
            // Calculate PnL based on average prices for the volume that was actually "turned over"
            const avgBuyPrice = data.totalSolSpent / data.totalSplBought;
            const avgSellPrice = data.totalSolReceived / data.totalSplSold;
            const volumeTraded = Math.min(data.totalSplBought, data.totalSplSold);

            realizedPnlSol = (avgSellPrice * volumeTraded) - (avgBuyPrice * volumeTraded);

            if (realizedPnlSol > 1e-9) { // Use a small epsilon for floating point comparisons
                 pnlScore = 100; // Profit
            } else if (realizedPnlSol < -1e-9) {
                 pnlScore = 0;   // Loss
            } // else stays 50 for break-even
        } else if (data.totalSplSold > 0 && data.totalSplBought === 0) {
            // Sold tokens that were not recorded as bought (e.g., airdrop, transfer-in)
            realizedPnlSol = data.totalSolReceived;
            if (realizedPnlSol > 1e-9) pnlScore = 100; // Profit
            // else stays 50 (if 0 SOL received, it's break-even on this metric)
        }
        // If only bought (totalSplBought > 0 && totalSplSold === 0), PnL is unrealized, score remains 50.

        return {
            mint: data.mint,
            totalSolSpent: data.totalSolSpent,
            totalSplBought: data.totalSplBought,
            avgBuyPrice: data.totalSplBought > 0 ? (data.totalSolSpent / data.totalSplBought) : null,
            totalSolReceived: data.totalSolReceived,
            totalSplSold: data.totalSplSold,
            avgSellPrice: data.totalSplSold > 0 ? (data.totalSolReceived / data.totalSplSold) : null,
            netSolFlow: data.totalSolReceived - data.totalSolSpent, // Overall SOL in/out for this token
            realizedPnlSol: realizedPnlSol, // Estimated PnL for the traded portion
            pnlScore: pnlScore,
            tradeCount: data.tradeCount
        };
    });
    let totalScore = finalScores.reduce((a,b) => {
        return a+b;
    })
    console.log({ totalScore, realizedPnlSol: finalScores[finalScores.length-1].pnlScore })
    return {
        events: events.sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0)), // Handle potentially undefined blockTime
        scores: finalScores
    };
}


const { calculateSwapPnLScore } = require('./pnl1'); // Import the new function

// 4. Compute realized PnL per token‐pair via FIFO matching for the target mint
async function computeRealizedPnLForTargetMint(events, targetMint) {
    const results = [];
    for (const ev of events) {
        // All events should already be filtered for the targetMint
        if (ev.mint !== targetMint) {
            console.warn(`[computePnL] Received event for non-target mint ${ev.mint} in tx ${ev.signature}. Skipping.`);
            continue;
        }

        const scoreResult = calculateSwapPnLScore(ev, ev.signer, {
            'So11111111111111111111111111111111111111112': 1, // SOL price in SOL is 1
        });

        results.push(scoreResult);
    }
    return results;
}

// 5. Main CLI
async function main() {
    console.time("Total Execution Time");
    try {
        await redisClient.connect();
        console.log("🔌 Redis connected.");
    } catch (err) {
        console.error("❌ Failed to connect to Redis:", err);
        process.exit(1);
    }

    const mint = process.env.MINT_ADDRESS;
    const rpcUrl = process.env.RPC_URL || DEFAULT_RPC;
    const apiKey = process.env.HELIUS_API_KEY;

    if (!mint || !apiKey) {
        console.error("❌ Please set MINT_ADDRESS, HELIUS_API_KEY (and optionally RPC_URL, REDIS_URL)");
        await redisClient.quit();
        process.exit(1);
    }
    if (!process.env.REDIS_URL) {
        console.warn("⚠️ REDIS_URL not set, using default redis://localhost:6379");
    }
     if (!process.env.RPC_URL) {
        console.warn("⚠️ RPC_URL not set, using default https://api.mainnet-beta.solana.com");
    }

    console.log(`🪙 Target Mint: ${mint}`);
    console.log(`⚡ RPC Endpoint: ${rpcUrl}`);
    console.log(`🔑 Helius Key: ${apiKey.substring(0,4)}...${apiKey.substring(apiKey.length-4)}`);


    let holders = [];
    try {
        console.log(`\n🔗 Fetching holders of ${mint}...`);
        console.time("Holder Fetch Time");
        holders = await fetchHolders(mint, rpcUrl);
        console.timeEnd("Holder Fetch Time");
        console.log(`   → Found ${holders.length} holders with non-zero balance.`);
    } catch (error) {
        console.error(`❌ Error fetching holders: ${error.message}`);
        await redisClient.quit();
        process.exit(1);
    }

    const results = [];
    let holderCount = 0;
    for (const h of holders) {
        holderCount++;
        console.log(`\n--- Processing holder ${holderCount}/${holders.length}: ${h.owner} (Balance: ${h.balance.toFixed(4)}) ---`);
        try {
            console.time(`Holder ${h.owner} Processing Time`);

            console.time(`  Tx Fetch Time [${h.owner}]`);
            const parsedTxs = await fetchParsedTxs(h.owner, apiKey);
            console.timeEnd(`  Tx Fetch Time [${h.owner}]`);

            console.time(`  Trade Event Build Time [${h.owner}]`);
            const tradeEvents = await buildTradeEvents(parsedTxs, h.owner, rpcUrl);
            console.timeEnd(`  Trade Event Build Time [${h.owner}]`);
            console.log(`   → Found ${tradeEvents.length} buy/sell events involving ${mint}.`);
            const scores = tradeEvents.scores; 
            const score = scores[scores.length-1].pnlScore;
            const score2 = scores[scores.length-1].realizedPnlSol;
            console.log({
                score,
                score2
            })
         
            results.push({
                owner: h.owner,
                balance: h.balance.toFixed(4),
                targetMintEvents: tradeEvents.length,
                // For the table, maybe just show SOL PnL or a summary
                realizedPnLSOL: score,
                pnlCurrencies:1
            });

             console.timeEnd(`Holder ${h.owner} Processing Time`);

        } catch (error) {
            console.error(`❌ Error processing holder ${h.owner}: ${error.message}`);
             console.error(error.stack); // Log stack trace for debugging
             results.push({
                owner: h.owner,
                balance: h.balance.toFixed(4),
                targetMintEvents: 'Error',
                realizedPnLSOL: 'Error',
                pnlCurrencies: 'Error'
            });
        }
    }


    console.log(`\n--- Realized PnL vs ${SOL_MINT_ADDRESS} (SOL) ---`);
    // Adjust console.table columns if needed
    console.table(results, ["owner", "balance", "targetMintEvents", "realizedPnLSOL", "pnlCurrencies"]);

    try {
        await redisClient.quit();
        console.log("🔌 Redis connection closed.");
    } catch(err) {
        console.error("Error closing Redis connection:", err);
    }
    console.timeEnd("Total Execution Time");
}

main().catch(err => {
    console.error("Fatal Error:", err);
    // Ensure redis client is quit even on fatal error
    if (redisClient && redisClient.isOpen) {
       redisClient.quit().catch(console.error);
    }
    process.exit(1);
});




/**
 * Calculate a trader's PnL and score based on swap history.
 *
 * @param {Array<Object>} accountData - Array of transaction account entries.
 * @param {string} userAccount - The user's main wallet public key.
 * @param {Object} [priceMap={}] - Optional mapping from token mint address to price in SOL.
 * @returns {{ pnlInSol: number, score: number, isGoodTrader: boolean }}
 *   pnlInSol     - Net profit and loss expressed in SOL.
 *   score        - Performance score (0-100).
 *   isGoodTrader - True if score >= 50, false otherwise.
 */

const LAMPORTS_PER_SOL = 1e9;

function calculateUserPnLScore(accountData, userAccount, priceMap = {}) {
  let totalNativeLamports = 0;
  let totalTokenProfitSol = 0;
  let totalTradeVolumeSol = 0;

  // Process each entry in the transaction
  accountData.forEach(entry => {
    // Sum up native SOL changes for the user account
    if (entry.account === userAccount && typeof entry.nativeBalanceChange === 'number') {
      totalNativeLamports += entry.nativeBalanceChange;
      totalTradeVolumeSol += Math.abs(entry.nativeBalanceChange) / LAMPORTS_PER_SOL;
    }

    // Process token changes for the user
    if (Array.isArray(entry.tokenBalanceChanges)) {
      entry.tokenBalanceChanges.forEach(tokenChange => {
        if (tokenChange.userAccount !== userAccount) return;

        const rawAmount = Number(tokenChange.rawTokenAmount.tokenAmount);
        const decimals = tokenChange.rawTokenAmount.decimals;
        const amount = rawAmount / Math.pow(10, decimals);
        const mint = tokenChange.mint;
        const priceInSol = priceMap[mint] || 0;

        // Profit from this token leg in SOL
        const profitSol = amount * priceInSol;
        totalTokenProfitSol += profitSol;
        totalTradeVolumeSol += Math.abs(amount * priceInSol);
      });
    }
  });

  // Convert native lamports to SOL
  const pnlNativeSol = totalNativeLamports / LAMPORTS_PER_SOL;
  const pnlInSol = pnlNativeSol + totalTokenProfitSol;

  // Compute a bounded score (0 = worst, 100 = best)
  let score = 0;
  if (totalTradeVolumeSol > 0) {
    const ratio = pnlInSol / totalTradeVolumeSol;
    // Nonlinear scaling: tanh to squeeze extreme ratios
    score = Math.tanh(ratio) * 100;
  }
  // Clamp
  score = Math.max(0, Math.min(100, score));

  return {
    pnlInSol,
    score,
    isGoodTrader: score >= 50
  };
}

// Export for Node.js
module.exports = { calculateUserPnLScore };

// Example usage:
// const { calculateUserPnLScore } = require('./traderScore');
// const result = calculateUserPnLScore(accountData, '9JGuVmjXTeMea6VY6fpsu8783YeJME8bewyy9qv9UBxh', {
//   '8sv4W4uQ9qML87Kr2XFkYBDwsiFEJVZZ1ScsM71Hpump': 0.5, // example price in SOL
//   'So11111111111111111111111111111111111111112': 1
// });
// console.log(result);
