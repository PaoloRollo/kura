"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useKuraUser } from "@/hooks/use-kura-user";

export function SiteHeader({ role }: { role: "vendor" | "collector" }) {
  const { ready, authenticated, login, logout, address, isVendor } = useKuraUser();
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
  return (
    <header className="flex items-center justify-between border-b px-4 py-3">
      <Link href="/" className="text-lg font-semibold">Kura</Link>
      <div className="flex items-center gap-3">
        <Badge variant="outline">{role === "vendor" ? "Vendor station" : "Collector"}</Badge>
        {isVendor && role === "collector" && <Badge>vendor</Badge>}
        {ready && authenticated ? (
          <>
            <span className="font-mono text-sm text-muted-foreground">{short}</span>
            <Button size="sm" variant="ghost" onClick={logout}>Log out</Button>
          </>
        ) : (
          <Button size="sm" onClick={login} disabled={!ready}>Log in</Button>
        )}
      </div>
    </header>
  );
}
