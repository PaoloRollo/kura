"use client";

import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useKuraUser } from "@/hooks/use-kura-user";

export default function CollectorLayout({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login } = useKuraUser();
  return (
    <div className="min-h-screen">
      <SiteHeader role="collector" />
      <main className="mx-auto max-w-6xl px-4 py-6">
        {!ready ? null : !authenticated ? (
          <Card className="mx-auto max-w-md"><CardHeader><CardTitle>Kura</CardTitle></CardHeader>
            <CardContent><Button onClick={login}>Log in</Button></CardContent></Card>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
