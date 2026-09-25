import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function VendorHome() {
  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>Vendor station</CardTitle>
      </CardHeader>
      <CardContent className="flex gap-3">
        <Button asChild>
          <Link href="/vendor/scan">Scan a card</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/vendor/vault">Vault</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
