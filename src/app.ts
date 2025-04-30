import { Connection, PublicKey, ParsedAccountData } from "@solana/web3.js";

async function fetchHolders(mintAddress: string, rpcUrl: string) {
  const connection = new Connection(rpcUrl);
  const MINT = new PublicKey(mintAddress);
  // Token Program ID
  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

  // Fetch all token accounts for this mint
  const accounts = await connection.getParsedProgramAccounts(
    TOKEN_PROGRAM_ID,
    {
      filters: [
        { dataSize: 165 },                            // SPL Token account size
        { memcmp: { offset: 0, bytes: mintAddress } } // Mint filter
      ]
    }
  );

  // Extract non-zero balances and owners
  const holders = accounts
    .map(({ pubkey, account }) => {
      // Ensure data is ParsedAccountData
      if (!('parsed' in account.data)) {
        return null; // Skip if not parsed
      }
      const info = account.data.parsed.info;
      const balance = Number(info.tokenAmount.uiAmount || 0);
      return balance > 0
        ? { owner: info.owner as string, balance } // Added type assertion for owner
        : null;
    })
    .filter((holder): holder is { owner: string; balance: number } => holder !== null); // Type guard to filter out nulls

  // Dedupe by owner
  const unique: { [owner: string]: number } = {}; // Explicitly type unique
  holders.forEach(h => {
    if (!unique[h.owner]) unique[h.owner] = 0;
    unique[h.owner] += h.balance;
  });

  return Object.entries(unique).map(([owner, balance]) => ({ owner, balance }));
}

// Example usage:
(async () => {
  const holders = await fetchHolders(
    "HobHTXpK1KQf9o46G6hAX3rfyH3x7ovdnaF6p1MEpump",
    "https://solana-mainnet.g.alchemy.com/v2/uiewrTaHl22ANTYLuV2zS3w1rWz-rGJd"
  );
  console.log(`Found ${holders.length} holders.`);
  console.table(holders.slice(0, 10)); // show first 10
})();
