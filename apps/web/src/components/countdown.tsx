"use client";

import { useEffect, useState } from "react";
import { usePonderStatus } from "@ponder/react";
import { blocksToSeconds, countdown, countdownSeconds } from "@/lib/format";

/**
 * Time left until `endBlock`, ticking every second.
 *
 * The deadline is anchored on chain time: the indexer head's timestamp plus 12 s per remaining block,
 * so it doesn't drift with the browser clock and resets whenever the indexer reports a new block.
 * The first render (server and hydration) shows the block-based value; ticking starts after mount.
 */
export function Countdown({ endBlock, fallback = "…" }: { endBlock: bigint; fallback?: string }) {
  const head = usePonderStatus().data?.sepolia?.block;
  const [now, setNow] = useState<number | null>(null);

  const deadline = head ? head.timestamp + blocksToSeconds(endBlock - BigInt(head.number)) : null;
  const left = deadline != null && now != null ? deadline - now : null;
  // Under a day the format shows seconds, so tick every second; otherwise once a minute is enough.
  const interval = left == null || left < 86_400 ? 1000 : 60_000;

  useEffect(() => {
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), interval);
    return () => clearInterval(id);
  }, [interval]);

  if (!head) return <>{fallback}</>;
  const text = left != null ? countdownSeconds(left) : countdown(endBlock - BigInt(head.number));
  return <time suppressHydrationWarning>{text}</time>;
}
