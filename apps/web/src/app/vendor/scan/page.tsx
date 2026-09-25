"use client";

import { useCallback, useState } from "react";
import { isAddress } from "viem";
import { toast } from "sonner";
import { CONDITIONS, isDeployed, DeploymentsSchema } from "@kura/shared";
import deployments from "@/generated/deployments.json";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QrScanner } from "@/components/qr-scanner";
import { apiFetch, useKuraUser } from "@/hooks/use-kura-user";
import type { Candidate } from "@/lib/scryfall";

type Step = "pick" | "details" | "owner" | "review";
const LANGUAGES = ["en", "ja", "zhs", "zht", "ko", "de", "fr", "it", "es", "pt", "ru"];

export default function ScanPage() {
  const { identityToken } = useKuraUser();
  const [step, setStep] = useState<Step>("pick");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [condition, setCondition] = useState<(typeof CONDITIONS)[number]>("NM");
  const [language, setLanguage] = useState("en");
  const [foil, setFoil] = useState(false);
  const [owner, setOwner] = useState<`0x${string}` | null>(null);
  const [manual, setManual] = useState("");
  const deployed = isDeployed(DeploymentsSchema.parse(deployments));
  // Stable identity so the QR scanner's camera effect is not restarted on every render.
  const onQrAddress = useCallback((a: `0x${string}`) => {
    setOwner(a);
    setStep("review");
  }, []);

  async function search() {
    const res = await apiFetch(`/api/scan/search?q=${encodeURIComponent(manual)}`, { identityToken });
    if (res.ok) setCandidates((await res.json()).candidates);
    else toast.error("Search failed, try again in a moment");
  }

  function choose(c: Candidate) {
    setChosen(c);
    setLanguage(c.lang);
    setStep("details");
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader><CardTitle>Scan a card</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {step === "pick" && (
            <div className="space-y-4">
              {candidates.length === 0 && <p className="text-sm text-muted-foreground">Search the card by name.</p>}
              <div className="grid gap-3 sm:grid-cols-3">
                {candidates.map((c) => (
                  <button key={c.scryfallId} onClick={() => choose(c)} className="rounded-lg border p-2 text-left hover:bg-accent">
                    {/* eslint-disable-next-line @next/next/no-img-element -- remote Scryfall images, not optimised */}
                    <img src={c.imageSmall || c.image} alt={c.name} className="mb-2 w-full rounded" />
                    <div className="font-medium">{c.printedName ?? c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.setName} · #{c.collectorNumber} · {c.lang} · ${c.prices.usd ?? "?"}</div>
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Input placeholder="Search by name" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
                <Button variant="secondary" onClick={search}>Search</Button>
              </div>
            </div>
          )}
          {step === "details" && chosen && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div><Label>Condition</Label>
                <Select value={condition} onValueChange={(v) => setCondition(v as typeof condition)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{CONDITIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select></div>
              <div><Label>Language</Label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{LANGUAGES.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent>
                </Select></div>
              <div><Label>Finish</Label>
                <Select value={foil ? "foil" : "nonfoil"} onValueChange={(v) => setFoil(v === "foil")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="nonfoil">Non-foil</SelectItem><SelectItem value="foil">Foil</SelectItem></SelectContent>
                </Select></div>
              <Button className="sm:col-span-3" onClick={() => setStep("owner")}>Assign owner</Button>
            </div>
          )}
          {step === "owner" && (
            <div className="space-y-3">
              <QrScanner onAddress={onQrAddress} />
              <div className="flex gap-2">
                <Input placeholder="0x… paste the collector's address" onChange={(e) => setOwner(isAddress(e.target.value) ? (e.target.value as `0x${string}`) : null)} />
                <Button disabled={!owner} onClick={() => setStep("review")}>Use address</Button>
              </div>
            </div>
          )}
          {step === "review" && chosen && owner && (
            <div className="space-y-3">
              <p className="text-sm">Ready to mint <strong>{chosen.name}</strong> ({chosen.setCode.toUpperCase()}, {condition}, {language}{foil ? ", foil" : ""}) to <span className="font-mono">{owner}</span>.</p>
              <p className="text-sm text-muted-foreground">ENS name will be <span className="font-mono">{`${chosen.slug}-${chosen.setCode}-N`}.{deployments.ensParentLabel}.eth</span> where N is the token id.</p>
              <Button size="lg" disabled={!deployed} title={deployed ? undefined : "Contracts are not deployed yet"}>Mint digital twin</Button>
              <Button variant="ghost" onClick={() => { setStep("pick"); setChosen(null); setOwner(null); }}>Start over</Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Frame</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- remote Scryfall image, not optimised */}
          {chosen ? <img src={chosen.image} alt={chosen.name} className="w-full rounded" /> : <p className="text-sm text-muted-foreground">No card chosen yet</p>}
          {chosen && <Badge variant="secondary">{chosen.scryfallId}</Badge>}
        </CardContent>
      </Card>
    </div>
  );
}
