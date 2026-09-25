import Link from "next/link";
import { ArrowRightIcon, LandmarkIcon, ScanLineIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function VendorHome() {
  return (
    <section className="mx-auto flex max-w-[40rem] flex-col gap-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[32px] font-semibold text-text">Vendor station</h1>
        <p className="text-[14px] text-text-2">Scan a card at the counter to mint its digital twin into the vault.</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
          <ScanLineIcon className="size-5 text-shu" />
          <h2 className="text-[16px] font-semibold text-text">Scan a card</h2>
          <p className="text-[13px] text-text-2">Recognise the printing, set the details, assign the owner.</p>
          <Button asChild variant="primary" size="md" className="mt-auto w-fit">
            <Link href="/vendor/scan">Open the scanner<ArrowRightIcon /></Link>
          </Button>
        </div>
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
          <LandmarkIcon className="size-5 text-kin" />
          <h2 className="text-[16px] font-semibold text-text">Vault</h2>
          <p className="text-[13px] text-text-2">Inventory, handovers and fees arrive with the contracts.</p>
          <Button variant="disabled" size="md" className="mt-auto w-fit" aria-disabled>Coming soon</Button>
        </div>
      </div>
    </section>
  );
}
