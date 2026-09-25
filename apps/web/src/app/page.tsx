import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-8 px-4 text-center">
      <h1 className="text-5xl font-semibold tracking-tight">Kura</h1>
      <p className="max-w-xl text-muted-foreground">
        Your cards stay in the vault. Their value moves.
      </p>
      <div className="flex gap-4">
        <Button asChild size="lg">
          <Link href="/app">Collector app</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/vendor">Vendor station</Link>
        </Button>
      </div>
    </main>
  );
}
