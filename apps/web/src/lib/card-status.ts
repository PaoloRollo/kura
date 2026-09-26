// A card's status, the one rule every state pill uses (card page, explore, vendor inventory): an auction reads
// "Live" only until its end block, then "Ended" with how it ended, never "sharded".
import type { PillTone } from "@/components/kura/pill";

export type CardStatusKey = "whole" | "live" | "awaiting" | "sold" | "reserve-not-met" | "ended" | "released";

export type CardStatus = {
  key: CardStatusKey;
  /** For a pill: "Live", "Ended · sold". */
  label: string;
  /** For a `·`-separated line: "live", "ended, sold". */
  short: string;
  tone: PillTone;
};

const STATUS: Record<CardStatusKey, Omit<CardStatus, "key">> = {
  whole: { label: "Whole", short: "whole", tone: "neutral" },
  live: { label: "Live", short: "live", tone: "live" },
  awaiting: { label: "Ended · awaiting settle", short: "ended, awaiting settle", tone: "neutral" },
  sold: { label: "Ended · sold", short: "ended, sold", tone: "sharded" },
  "reserve-not-met": { label: "Ended · reserve not met", short: "ended, reserve not met", tone: "neutral" },
  // A sharded card whose sharding hasn't loaded yet.
  ended: { label: "Ended", short: "ended", tone: "sharded" },
  released: { label: "Released", short: "released", tone: "released" },
};

export function cardStatusOf(key: CardStatusKey): CardStatus {
  return { key, ...STATUS[key] };
}

/**
 * The status of a card in `state`, from its current sharding and the indexer's head block:
 * - auctioning, before the end block (or while the block is unknown): Live;
 * - auctioning, at or past the end block: Ended · awaiting settle (once the sharding says settled, as sharded below:
 *   the card row can lag its sharding by a block);
 * - sharded: Ended · sold when the auction graduated, Ended · reserve not met when it didn't;
 * - whole and released as they are.
 */
export function cardStatus(
  card: { state: "whole" | "auctioning" | "sharded" | "released" },
  sharding: { endBlock?: bigint | null; graduated?: boolean | null; settled?: boolean | null } | null | undefined,
  block: bigint | null | undefined,
): CardStatus {
  if (card.state === "whole" || card.state === "released") return cardStatusOf(card.state);
  if (card.state === "auctioning" && !sharding?.settled) {
    const ended = block != null && sharding?.endBlock != null && block >= sharding.endBlock;
    return cardStatusOf(ended ? "awaiting" : "live");
  }
  return cardStatusOf(sharding?.graduated === true ? "sold" : sharding?.graduated === false ? "reserve-not-met" : "ended");
}
