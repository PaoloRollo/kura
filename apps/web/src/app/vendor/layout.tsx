"use client";

import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useKuraUser } from "@/hooks/use-kura-user";

export default function VendorLayout({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, isVendor, address } = useKuraUser();
  return (
    <div className="min-h-screen">
      <SiteHeader role="vendor" />
      <main className="mx-auto max-w-6xl px-4 py-6">
        {!ready ? null : !authenticated ? (
          <Card className="mx-auto max-w-md"><CardHeader><CardTitle>Vendor station</CardTitle></CardHeader>
            <CardContent><Button onClick={login}>Log in</Button></CardContent></Card>
        ) : !isVendor ? (
          <Card className="mx-auto max-w-md"><CardHeader><CardTitle>Not authorised</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {address} is not the whitelisted vendor for this vault.
            </CardContent></Card>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
