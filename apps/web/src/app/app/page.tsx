import { CompassIcon } from "lucide-react";

export default function ExplorePage() {
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[28px] font-semibold text-text md:text-[32px]">Live auctions</h1>
        <p className="text-[14px] text-text-2">Uniswap continuous clearing auctions. Set a budget and a max price, everyone pays the same.</p>
      </header>
      <div className="flex flex-col items-start gap-3 rounded-3xl border border-border bg-surface p-6">
        <span className="flex size-11 items-center justify-center rounded-md bg-surface-2 text-text-2"><CompassIcon className="size-5" /></span>
        <h2 className="text-[16px] font-semibold text-text">No auctions yet</h2>
        <p className="text-[14px] text-text-2">Auctions appear here once contracts are live.</p>
      </div>
    </section>
  );
}
