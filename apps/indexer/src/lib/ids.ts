/** Activity and append-only event ids: `txHash-logIndex`, stable across reorgs. */
export const logId = (txHash: string, logIndex: number) => `${txHash.toLowerCase()}-${logIndex}`;
export const holderId = (token: string, holder: string) => `${token.toLowerCase()}-${holder.toLowerCase()}`;
export const bidRowId = (auction: string, bidId: bigint) => `${auction.toLowerCase()}-${bidId.toString()}`;
export const tickId = (auction: string, block: bigint) => `${auction.toLowerCase()}-${block.toString()}`;
export const checkpointId = (auction: string, block: bigint) => `${auction.toLowerCase()}-${block.toString()}`;
