import { CircleCheckIcon, PrinterIcon, ScanLineIcon } from "lucide-react";
import { CardArt } from "@/components/kura";
import { Button } from "@/components/ui/button";

export type MintResult = {
  image: string;
  name: string;
  tokenId: string;
  ensName: string;
  owner: string;
  condition: string;
  language: string;
  block?: string;
  slot?: string;
};

/** Mint success (anR2F). Visual only until minting is wired: the station renders it for step "minted". */
export function MintSuccess({ result, onScanNext, onPrint }: { result: MintResult; onScanNext: () => void; onPrint?: () => void }) {
  const rows: [string, string, boolean?][] = [
    ["Token", `#${result.tokenId}`],
    ["ENS name", result.ensName, true],
    ["Owner", result.owner],
    ["Condition · language", `${result.condition} · ${result.language.toUpperCase()}`],
    ...(result.slot ? ([["Slot", result.slot]] as [string, string][]) : []),
  ];
  return (
    <section className="grid min-h-[calc(100dvh-12rem)] items-center gap-12 py-8 md:grid-cols-[minmax(0,26rem)_minmax(0,33rem)] md:justify-center md:gap-24">
      <div className="relative mx-auto w-[min(20rem,70vw)]">
        <CardArt src={result.image} alt={result.name} className="w-full" loading="eager" />
        <span aria-hidden lang="ja" className="absolute -right-4 -bottom-4 flex size-24 items-center justify-center rounded-full bg-shu font-display text-[44px] text-white shadow-[0_12px_30px_#00000099]">
          蔵
        </span>
      </div>
      <div className="flex flex-col gap-5">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-good-soft px-3 py-1 text-[12px] font-medium text-good-fg">
          <CircleCheckIcon className="size-3.5" />
          {result.block ? `Minted in block ${result.block}` : "Minted"}
        </span>
        <h1 className="font-display text-[40px] leading-[1.05] font-semibold text-text md:text-[48px]">{result.name} is in the vault.</h1>
        <dl className="divide-y divide-border rounded-2xl border border-border bg-surface px-4">
          {rows.map(([k, v, kin]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-3">
              <dt className="text-[13px] text-text-2">{k}</dt>
              <dd className={`truncate font-mono text-[13px] ${kin ? "text-kin" : "text-text"}`}>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[14px] text-text-2">
          {result.slot ? `Put the card in sleeve ${result.slot}. ` : ""}The owner sees it in their portfolio now.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" size="md" onClick={onScanNext}><ScanLineIcon />Scan next card</Button>
          {onPrint && <Button variant="secondary" size="md" onClick={onPrint}><PrinterIcon />Print sleeve label</Button>}
        </div>
      </div>
    </section>
  );
}
