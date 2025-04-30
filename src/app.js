#!/usr/bin/env node

/**
 * Usage:
 *   npm install @solana/web3.js
 *   node index.js <MINT_ADDRESS> [RPC_URL]
 *
 * Example:
 *   node index.js HobHTXpK1KQf9o46G6hAX3rfyH3x7ovdnaF6p1MEpump
 */

const { Connection, PublicKey } = require("@solana/web3.js");

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

async function fetchHolders(mintAddress, rpcUrl) {
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });
  const MINT = new PublicKey(mintAddress);

  // Fetch all token accounts for this mint
  const accounts = await connection.getParsedProgramAccounts(
    TOKEN_PROGRAM_ID,
    {
      filters: [
        { dataSize: 165 },                            // SPL Token account size
        { memcmp: { offset: 0, bytes: mintAddress } } // Mint filter
      ],
    }
  );

  // Aggregate balances per owner
  const balances = accounts.reduce((acc, { account }) => {
    const info = account.data.parsed.info;
    const uiAmt = info.tokenAmount.uiAmount || 0;
    const owner = info.owner;
    if (uiAmt > 0) {
      acc[owner] = (acc[owner] || 0) + uiAmt;
    }
    return acc;
  }, {});

  // Convert to array of { owner, balance }
  return Object.entries(balances).map(([owner, balance]) => ({
    owner,
    balance,
  }));
}
 
async function main() {
  const [,, mint, rpc] = process.argv;
  if (!mint) {
    console.error("❌ Missing mint address\nUsage: node index.js <MINT_ADDRESS> [RPC_URL]");
    process.exit(1);
  }

  const rpcUrl = rpc || DEFAULT_RPC;
  console.log(`🔗 Connecting to ${rpcUrl}`);
  console.log(`🪙 Fetching holders for mint ${mint}…`);

  try {
    const holders = await fetchHolders(mint, rpcUrl);
    console.log(`✅ Found ${holders.length} holders.\n`);
    console.table(holders.slice(0, 20));  // show first 20 rows
  } catch (err) {
    console.error("❌ Error fetching holders:", err);
    process.exit(1);
  }
}

main();
