"use client";

import { useEffect, useState } from "react";
import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { indexerCollectors } from "@/lib/collectors";
import { shortAddress } from "@/lib/format";
import { resolveOwner, type CollectorDirectory, type ResolvedOwner } from "@/lib/owner";

const DEBOUNCE_MS = 300;

/** The owner's Kura handle, typed ("kenji" or "kenji.kura.eth"), resolved through the indexer after a 300 ms pause. */
export function OwnerHandleInput({
  onUse,
  directory = indexerCollectors,
}: {
  onUse: (owner: { address: Address; name: string }) => void;
  directory?: CollectorDirectory;
}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ for: string; value: ResolvedOwner | null } | null>(null);

  useEffect(() => {
    let live = true;
    const id = setTimeout(() => {
      void resolveOwner(text, directory).then((value) => live && setResult({ for: text, value }));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [text, directory]);

  // Only a result for the text as it stands now counts; anything older is still resolving.
  const current = result?.for === text ? result.value : undefined;
  const resolving = text.trim() !== "" && current === undefined;
  const resolved = current?.ok ? current : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          className="h-10 font-mono text-[13px]"
          placeholder="or type their Kura handle: kenji"
          aria-label="Owner's Kura handle"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && resolved) onUse(resolved);
          }}
        />
        <Button variant="primary" size="default" className="h-10 px-4" disabled={!resolved} onClick={() => resolved && onUse(resolved)}>
          Use handle
        </Button>
      </div>
      <p aria-live="polite" className="min-h-4 px-1 text-[12px]">
        {resolving ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Loader2Icon className="size-3 animate-spin" />Looking up…</span>
        ) : resolved ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-text-2">
            <CheckCircle2Icon className="size-3.5 text-good" />
            {resolved.name} · {shortAddress(resolved.address)}
          </span>
        ) : current && !current.ok ? (
          <span className="text-shu">{current.error}</span>
        ) : null}
      </p>
    </div>
  );
}
