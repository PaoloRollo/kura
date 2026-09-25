"use client";

import { useCallback, useEffect, useState } from "react";
import { isAddress } from "viem";
import { toast } from "sonner";
import { CONDITIONS, cardLabel, isDeployed, DeploymentsSchema } from "@kura/shared";
import deployments from "@/generated/deployments.json";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QrScanner } from "@/components/qr-scanner";
import { WebcamCapture } from "@/components/webcam-capture";
import { apiFetch, useKuraUser } from "@/hooks/use-kura-user";
import { embedCard, warmUpEmbedder, type LoadProgress } from "@/lib/card-embed";
import type { MatchCandidate } from "@/lib/card-match";
import type { Candidate } from "@/lib/scryfall";

type Step = "capture" | "matching" | "pick" | "search" | "edition" | "details" | "owner" | "review";
const LANGUAGES = ["en", "ja", "zhs", "zht", "ko", "de", "fr", "it", "es", "pt", "ru"];
type ModelState = { status: "loading"; progress: number | null } | { status: "ready"; device: string } | { status: "failed" };

/** fetch + JSON with every failure (network, non-2xx, bad JSON) turned into a thrown Error carrying the API's message. */
async function getJson<T>(path: string, init: Parameters<typeof apiFetch>[1]): Promise<T> {
  const res = await apiFetch(path, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fall through: reported below
  }
  if (!res.ok || body == null) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(message ?? `request failed (${res.status})`);
  }
  return body as T;
}

function CandidateTile({ c, onPick, note, highlight }: { c: Candidate; onPick: () => void; note?: string; highlight?: boolean }) {
  return (
    <button onClick={onPick} className={`rounded-lg border p-2 text-left hover:bg-accent ${highlight ? "ring-2 ring-primary" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- remote Scryfall images, not optimised */}
      <img src={c.imageSmall || c.image} alt={c.name} className="mb-2 w-full rounded" />
      <div className="font-medium">{c.printedName ?? c.name}</div>
      <div className="text-xs text-muted-foreground">{c.setName} ({c.setCode.toUpperCase()}) · #{c.collectorNumber} · {c.lang}</div>
      {note && <div className="mt-1 text-xs">{note}</div>}
    </button>
  );
}

export default function ScanPage() {
  const { identityToken } = useKuraUser();
  const [step, setStep] = useState<Step>("capture");
  const [model, setModel] = useState<ModelState>({ status: "loading", progress: null });
  const [capture, setCapture] = useState<string | null>(null);
  const [matches, setMatches] = useState<MatchCandidate[]>([]);
  const [confident, setConfident] = useState(false);
  const [group, setGroup] = useState<MatchCandidate | null>(null);
  const [results, setResults] = useState<Candidate[]>([]);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [condition, setCondition] = useState<(typeof CONDITIONS)[number]>("NM");
  const [language, setLanguage] = useState("en");
  const [foil, setFoil] = useState(false);
  const [owner, setOwner] = useState<`0x${string}` | null>(null);
  const [manual, setManual] = useState("");
  const [searching, setSearching] = useState(false);
  const deployed = isDeployed(DeploymentsSchema.parse(deployments));
  // Stable identity so the QR scanner's camera effect is not restarted on every render.
  const onQrAddress = useCallback((a: `0x${string}`) => {
    setOwner(a);
    setStep("review");
  }, []);

  // Load the embedding model as soon as the station opens, so the first scan does not wait for it.
  useEffect(() => {
    let live = true;
    const files = new Map<string, LoadProgress>();
    warmUpEmbedder((p) => {
      files.set(p.file, p);
      const all = [...files.values()];
      const total = all.reduce((s, f) => s + f.total, 0);
      if (live) setModel({ status: "loading", progress: total ? (100 * all.reduce((s, f) => s + f.loaded, 0)) / total : null });
    })
      .then((device) => live && setModel({ status: "ready", device }))
      .catch((e) => {
        console.error(e);
        if (live) setModel({ status: "failed" });
      });
    return () => {
      live = false;
    };
  }, []);

  function openSearch(prefill: string) {
    setManual(prefill);
    setResults([]);
    setStep("search");
    if (prefill.length >= 2) void search(prefill);
  }

  async function onCapture(card: HTMLCanvasElement) {
    setCapture(card.toDataURL("image/jpeg", 0.85));
    setStep("matching");
    try {
      const vector = await embedCard(card);
      const out = await getJson<{ draftId: string; confident: boolean; candidates: MatchCandidate[] }>("/api/scan/match", { method: "POST", identityToken, body: JSON.stringify({ vector }) });
      if (out.candidates.length === 0) {
        toast.info("No match found, search by name");
        openSearch("");
        return;
      }
      setMatches(out.candidates);
      setConfident(out.confident);
      setStep("pick");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Matching failed", { description: "Search by name instead" });
      openSearch("");
    }
  }

  async function search(q = manual) {
    if (q.trim().length < 2) return;
    setSearching(true);
    try {
      setResults((await getJson<{ candidates: Candidate[] }>(`/api/scan/search?q=${encodeURIComponent(q)}`, { identityToken })).candidates);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Search failed, try again in a moment");
    } finally {
      setSearching(false);
    }
  }

  function choose(c: Candidate) {
    setChosen(c);
    setLanguage(c.lang);
    setFoil(c.finishes.length > 0 && c.finishes.every((f) => f !== "nonfoil"));
    setStep("details");
  }

  // Records the pick so a manual scan is auditable the same way an embedding match already is; a
  // failure here should not block the vendor, who already has the card chosen.
  async function chooseManual(c: Candidate) {
    choose(c);
    try {
      await getJson("/api/scan/draft", { method: "POST", identityToken, body: JSON.stringify({ candidate: c }) });
    } catch (e) {
      console.error("failed to record manual scan draft", e);
    }
  }

  function pickArtwork(m: MatchCandidate) {
    if (m.siblings.length > 1) {
      setGroup(m);
      setStep("edition");
    } else choose(m);
  }

  function restart() {
    setStep("capture");
    setChosen(null);
    setGroup(null);
    setMatches([]);
    setOwner(null);
    setCapture(null);
  }

  // The token id is only known after minting; cardLabel formats the rest, the placeholder is appended here.
  const labelPrefix = chosen ? cardLabel(chosen.slug, chosen.setCode, 0).slice(0, -1) : "";

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader><CardTitle>Scan a card</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {step === "capture" && (
            <div className="space-y-3">
              {model.status === "loading" && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Loading the card matcher{model.progress != null ? ` (${model.progress.toFixed(0)}%)` : "…"} — first time only</p>
                  <Progress value={model.progress ?? 0} />
                </div>
              )}
              {model.status === "failed" && <p className="text-sm text-destructive">The card matcher could not load in this browser. Search by name instead.</p>}
              <WebcamCapture onCapture={onCapture} disabled={model.status !== "ready"} />
              <Button variant="ghost" onClick={() => openSearch("")}>Search by name instead</Button>
            </div>
          )}
          {step === "matching" && <p className="text-sm text-muted-foreground">Matching…</p>}
          {step === "pick" && (
            <div className="space-y-4">
              <p className="text-sm">{confident ? "Best match first. Pick the card:" : <strong>Not sure — pick or search</strong>}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {matches.map((m, i) => (
                  <CandidateTile
                    key={m.illustrationId}
                    c={m}
                    highlight={confident && i === 0}
                    onPick={() => pickArtwork(m)}
                    note={`score ${m.score.toFixed(2)}${m.siblings.length > 1 ? ` · ${m.siblings.length} printings` : ""}`}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {confident && <Button onClick={() => pickArtwork(matches[0])}>Use best match</Button>}
                <Button variant="secondary" onClick={() => openSearch(matches[0]?.name ?? "")}>Not it? Search by name</Button>
                <Button variant="ghost" onClick={restart}>Rescan</Button>
              </div>
            </div>
          )}
          {step === "search" && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Input placeholder="Search by name" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
                <Button variant="secondary" onClick={() => search()} disabled={searching}>{searching ? "Searching…" : "Search"}</Button>
              </div>
              {results.length === 0 && !searching && <p className="text-sm text-muted-foreground">Search the card by name.</p>}
              <div className="grid gap-3 sm:grid-cols-3">
                {results.map((c) => <CandidateTile key={c.scryfallId} c={c} onPick={() => chooseManual(c)} note={`$${c.prices.usd ?? "?"}`} />)}
              </div>
              <Button variant="ghost" onClick={restart}>Back to camera</Button>
            </div>
          )}
          {step === "edition" && group && (
            <div className="space-y-4">
              <p className="text-sm">This artwork appears in {group.siblings.length} printings. Pick the exact edition and language:</p>
              <div className="grid gap-3 sm:grid-cols-4">
                {group.siblings.map((c) => <CandidateTile key={c.scryfallId} c={c} highlight={c.scryfallId === group.scryfallId} onPick={() => choose(c)} />)}
              </div>
              <Button variant="ghost" onClick={() => setStep("pick")}>Back to matches</Button>
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
                  <SelectContent>{[...new Set([language, ...LANGUAGES])].map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent>
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
              <p className="text-sm text-muted-foreground">ENS name will be <span className="font-mono">{labelPrefix}N.{deployments.ensParentLabel}.eth</span> where N is the token id.</p>
              <Button size="lg" disabled={!deployed} title={deployed ? undefined : "Contracts are not deployed yet"}>Mint digital twin</Button>
              <Button variant="ghost" onClick={restart}>Start over</Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Frame</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- remote Scryfall image / local capture, not optimised */}
          {chosen ? <img src={chosen.image} alt={chosen.name} className="w-full rounded" /> : capture ? <img src={capture} alt="captured card" className="w-full rounded" /> : <p className="text-sm text-muted-foreground">No card chosen yet</p>}
          {chosen && <Badge variant="secondary">{chosen.scryfallId}</Badge>}
          {model.status === "ready" && <p className="text-xs text-muted-foreground">Card matcher on {model.device === "webgpu" ? "WebGPU" : "WASM"}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
