"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePonderStatus } from "@ponder/react";
import { blocksToSeconds, countdown, countdownSeconds } from "@/lib/format";

export type IndexerHead = { number: number | bigint; timestamp: number };

/** Dev previews provide their fixture head here so countdowns tick from the fixture block, not the live indexer. */
export const CountdownHead = createContext<IndexerHead | null>(null);

/**
 * Time left until `endBlock`, ticking every second.
 *
 * The deadline is anchored on chain time: the indexer head's timestamp plus 12 s per remaining block,
 * so it doesn't drift with the browser clock and resets whenever the indexer reports a new block.
 * The first render (server and hydration) shows the block-based value; ticking starts after mount.
 */
export function Countdown({ endBlock, fallback = "…" }: { endBlock: bigint; fallback?: string }) {
  const override = useContext(CountdownHead);
  const live = usePonderStatus().data?.sepolia?.block;
  const head = override ?? live;
  const [now, setNow] = useState<number | null>(null);

  const deadline = head ? head.timestamp + blocksToSeconds(endBlock - BigInt(head.number)) : null;
  const left = deadline != null && now != null ? deadline - now : null;
  // Under a day the format shows seconds, so tick every second; otherwise once a minute is enough.
  const interval = left == null || left < 86_400 ? 1000 : 60_000;

  useEffect(() => {
    const tick = () => setNow(Date.now() / 1000);
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, interval);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [interval]);

  if (!head) return <>{fallback}</>;
  const text = left != null ? countdownSeconds(left) : countdown(endBlock - BigInt(head.number));
  return <time suppressHydrationWarning>{text}</time>;
}
