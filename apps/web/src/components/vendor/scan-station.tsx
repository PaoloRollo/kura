"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useReadContract } from "wagmi";
import { CONDITIONS, abi, cardLabel, isDeployed, DeploymentsSchema } from "@kura/shared";
import deployments from "@/generated/deployments.json";
import { CheckCircle2Icon, ListChecksIcon, QrCodeIcon, RotateCcwIcon, ScanEyeIcon, StampIcon } from "lucide-react";
import { CardArt, Segmented, SearchInput, StatTile } from "@/components/kura";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { shortAddress } from "@/components/site-header";
import { MintDetailsUnavailable, MintReading, MintSuccess, type MintResult } from "@/components/vendor/mint-success";
import { Brackets, CandidateRow, HowRow, PanelHeading, ScanStage, StageChip, StationStepper } from "@/components/vendor/station";
import { QrScanner } from "@/components/qr-scanner";
import { OwnerHandleInput } from "@/components/vendor/owner-input";
import { TxStepper } from "@/components/tx-stepper";
import { WebcamCapture } from "@/components/webcam-capture";
import { apiFetch, useKuraUser } from "@/hooks/use-kura-user";
import { useNow } from "@/hooks/use-now";
import { useFeeEvents, useVaultCards } from "@/hooks/use-vendor-data";
import { addresses, publicClient } from "@/lib/chain";
import { money } from "@/lib/format";
import type { StepResult } from "@/lib/tx";
import { useSendTx } from "@/lib/tx";
import { AddressName } from "@/components/address-name";
import { indexerCollectors } from "@/lib/collectors";
import { cardPageUrl } from "@/lib/meta";
import { handleForAddress } from "@/lib/owner";
import { describeMintError, mintOutcome, stationStats } from "@/lib/vendor";
import { embedCard, warmUpEmbedder, type LoadProgress } from "@/lib/card-embed";
import type { MatchCandidate } from "@/lib/card-match";
import type { Candidate } from "@/lib/scryfall";

// "minted" follows a successful mint (anR2F).
export type Step = "capture" | "matching" | "pick" | "search" | "edition" | "details" | "owner" | "review" | "minted";
const STEP_INDEX: Record<Step, number> = { capture: 0, matching: 1, pick: 1, search: 1, edition: 1, details: 2, owner: 3, review: 4, minted: 5 };
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

const usd = (c: Candidate) => (c.prices.usd ? `$${Number(c.prices.usd).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : undefined);
const meta = (c: Candidate) => `${c.setCode.toUpperCase()} · #${c.collectorNumber} · ${c.lang.toUpperCase()}`;

/** The empty station's "Minted today / In custody / Fees today" row (g3IDaw), live from the indexer. */
function StationStats() {
  const cards = useVaultCards();
  const fees = useFeeEvents();
  const now = useNow();
  if (!cards.data || !fees.data) return null;
  const s = stationStats(cards.data, fees.data, now);
  return (
    <div className="flex justify-between gap-4 px-4 pt-3">
      <StatTile bare label="Minted today" value={s.mintedToday} />
      <StatTile bare label="In custody" value={s.inCustody} />
      <StatTile bare label="Fees today" value={money(s.feesToday)} />
    </div>
  );
}

function CandidateTile({ c, onPick, note, highlight }: { c: Candidate; onPick: () => void; note?: string; highlight?: boolean }) {
  return <CandidateRow image={c.imageSmall || c.image} name={c.printedName ?? c.name} meta={meta(c)} price={usd(c)} note={note} selected={highlight} onPick={onPick} />;
}

type MintView = { kind: "reading"; hash: `0x${string}` } | { kind: "unavailable"; hash?: `0x${string}`; reason: string } | { kind: "done"; result: MintResult };

/** Starting state for previews (the dev-only /design/station page); the live station starts empty. */
export type StationSeed = {
  step?: Step;
  capture?: string | null;
  matches?: MatchCandidate[];
  confident?: boolean;
  results?: Candidate[];
  chosen?: Candidate | null;
  owner?: `0x${string}` | null;
  ownerName?: string | null;
  manual?: string;
  minted?: MintResult | null;
  /** Preview the terminal "minted, details unavailable" state. */
  mintUnavailable?: { hash: `0x${string}`; reason: string };
};

export function ScanStation({ seed }: { seed?: StationSeed }) {
  const { identityToken } = useKuraUser();
  const { send, walletKind } = useSendTx();
  const [step, setStep] = useState<Step>(seed?.step ?? "capture");
  // A seeded preview never loads the embedding model.
  const [model, setModel] = useState<ModelState>(seed ? { status: "ready", device: "wasm" } : { status: "loading", progress: null });
  const [capture, setCapture] = useState<string | null>(seed?.capture ?? null);
  const [matches, setMatches] = useState<MatchCandidate[]>(seed?.matches ?? []);
  const [confident, setConfident] = useState(seed?.confident ?? false);
  const [group, setGroup] = useState<MatchCandidate | null>(null);
  const [results, setResults] = useState<Candidate[]>(seed?.results ?? []);
  const [chosen, setChosen] = useState<Candidate | null>(seed?.chosen ?? null);
  const [condition, setCondition] = useState<(typeof CONDITIONS)[number]>("NM");
  const [language, setLanguage] = useState("en");
  const [foil, setFoil] = useState(false);
  const [owner, setOwner] = useState<`0x${string}` | null>(seed?.owner ?? null);
  const [manual, setManual] = useState(seed?.manual ?? "");
  const [searching, setSearching] = useState(false);
  // Set as soon as the mint confirms, and only cleared by a restart: a confirmed mint must never re-arm the Mint button.
  const [minted, setMinted] = useState<MintView | null>(
    seed?.minted ? { kind: "done", result: seed.minted } : seed?.mintUnavailable ? { kind: "unavailable", ...seed.mintUnavailable } : null,
  );
  // The owner's Kura handle: typed, or looked up for a scanned address. Null when the address has none.
  const [ownerName, setOwnerName] = useState<string | null>(seed?.ownerName ?? null);
  const [ownerSource, setOwnerSource] = useState<"qr" | "handle">("qr");
  const deployed = isDeployed(DeploymentsSchema.parse(deployments));
  // Stable identity so the QR scanner's camera effect is not restarted on every render.
  const onQrAddress = useCallback((a: `0x${string}`) => {
    setOwner(a);
    setOwnerName(null);
    setOwnerSource("qr");
    setStep("review");
  }, []);

  // Load the embedding model as soon as the station opens, so the first scan does not wait for it.
  const warm = !seed;
  useEffect(() => {
    if (!warm) return;
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
  }, [warm]);

  // A scanned address is shown by its Kura handle when it has one.
  useEffect(() => {
    if (!owner || ownerSource !== "qr" || seed) return;
    let live = true;
    void handleForAddress(owner, indexerCollectors).then((name) => live && setOwnerName(name));
    return () => {
      live = false;
    };
  }, [owner, ownerSource, seed]);

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
    setMinted(null);
    setStep("capture");
    setChosen(null);
    setGroup(null);
    setMatches([]);
    setOwner(null);
    setOwnerName(null);
    setCapture(null);
  }

  const stepIndex = STEP_INDEX[step];
  const ownerLabel = owner ? (ownerName ?? shortAddress(owner)) : "";
  const ensParent = `${deployments.ensParentLabel}.eth`;
  // The id the next mint expects. A concurrent mint can take it; the authoritative label comes from CardMinted.
  const nextId = useReadContract({
    address: addresses.cardVault,
    abi: abi.cardVault,
    functionName: "nextId",
    query: { enabled: deployed && !!chosen, refetchInterval: step === "review" ? 12_000 : false },
  }).data;
  // Card pages are the vault's siteURI + id, for the sleeve label's QR.
  const siteUri = useReadContract({ address: addresses.cardVault, abi: abi.cardVault, functionName: "siteURI", query: { enabled: deployed, staleTime: Infinity } }).data;
  const willMint = chosen ? `${nextId != null ? cardLabel(chosen.slug, chosen.setCode, nextId) : cardLabel(chosen.slug, chosen.setCode, 0).slice(0, -1) + "N"}.${ensParent}` : `card-set-N.${ensParent}`;
  const description = chosen ? `${chosen.name}, ${chosen.setName}${foil ? ", foil" : ""}` : "";

  async function onMinted(results: StepResult[]) {
    if (!chosen || !owner) return;
    const hash = results.find((x) => x.status === "done")?.hash;
    // Lock the station first: whatever happens next, this mint is done and the inputs can't be minted again.
    setStep("minted");
    if (!hash) {
      setMinted({ kind: "unavailable", reason: "The mint confirmed but its transaction hash is missing." });
      return;
    }
    setMinted({ kind: "reading", hash });
    const out = await mintOutcome(hash, (h) => publicClient.getTransactionReceipt({ hash: h }));
    if (out.status !== "minted") {
      setMinted({ kind: "unavailable", hash, reason: out.reason });
      return;
    }
    setMinted({
      kind: "done",
      result: {
        image: chosen.image,
        name: chosen.name,
        set: `${chosen.setCode.toUpperCase()} · ${chosen.setName}`,
        tokenId: out.id.toString(),
        ensName: `${out.label}.${ensParent}`,
        owner: ownerName ?? owner,
        condition,
        language,
        block: out.blockNumber.toLocaleString("en-US"),
        url: cardPageUrl(siteUri, out.id),
      },
    });
  }
  const detailsOpen = step === "details" || step === "owner" || step === "review";
  // The Details/Owner/Mint block is previewed (dimmed) while the card is still being identified.
  const showForm = stepIndex >= 1 && step !== "matching";
  const top: MatchCandidate | undefined = matches[0];
  const stageImage = chosen?.image ?? capture;
  const recognised = !!chosen || (step === "pick" && confident);
  const score = chosen ? (group?.score ?? (confident ? top?.score : undefined)) : top?.score;

  if (step === "minted" && minted) {
    if (minted.kind === "reading") return <MintReading hash={minted.hash} />;
    if (minted.kind === "unavailable") return <MintDetailsUnavailable hash={minted.hash} reason={minted.reason} onScanNext={restart} />;
    return <MintSuccess result={minted.result} onScanNext={restart} onPrint={() => window.print()} />;
  }

  const searchBox = (
    <form
      className="flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        openSearch(String(new FormData(e.currentTarget).get("q") ?? ""));
      }}
    >
      <SearchInput name="q" aria-label="Search Scryfall by name" placeholder="Not right? Search Scryfall by name" boxClassName="h-[46px] py-0" />
    </form>
  );

  const modelChip =
    model.status === "loading" ? (
      <span className="flex w-72 max-w-full flex-col gap-2 rounded-md border border-border bg-bg/80 px-3.5 py-2.5 text-[12px] text-text-2 backdrop-blur">
        Loading the card matcher{model.progress != null ? ` (${model.progress.toFixed(0)}%)` : "…"} — first time only
        <Progress value={model.progress ?? 0} className="h-1" />
      </span>
    ) : model.status === "failed" ? (
      <StageChip tone="warn">The card matcher could not load in this browser. Search by name instead.</StageChip>
    ) : undefined;

  const stageChip =
    step === "matching" ? (
      <StageChip>Matching…</StageChip>
    ) : chosen ? (
      <StageChip score={score}>{`${chosen.printedName ?? chosen.name} · ${chosen.setName}`}</StageChip>
    ) : step === "pick" && confident && top ? (
      <StageChip score={top.score}>{`${top.name} · ${top.setName}`}</StageChip>
    ) : capture ? (
      <StageChip tone="warn" score={top?.score}>Couldn&apos;t read this card</StageChip>
    ) : undefined;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] xl:gap-8">
      <div className="flex min-w-0 flex-col gap-4">
        <StationStepper current={stepIndex} />
        {step === "capture" ? (
          <WebcamCapture onCapture={onCapture} disabled={model.status !== "ready"} chip={modelChip} footer={searchBox} />
        ) : (
          <div className="flex flex-col gap-4">
            <ScanStage chip={stageChip}>
              <div className="relative aspect-[63/88] h-[min(29rem,62%)] max-h-[29rem] min-h-[16rem]">
                <Brackets tone={recognised ? "found" : "idle"} className="-inset-5" />
                {stageImage ? (
                  <CardArt src={stageImage} alt={chosen?.name ?? "captured card"} loading="eager" className={recognised ? "h-full w-full" : "h-full w-full brightness-75"} />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                    <p className="text-[16px] font-semibold text-text">Search the card by name</p>
                    <p className="text-[13px] text-text-2">Scryfall confirms the exact printing</p>
                  </div>
                )}
                {step === "matching" && <span aria-hidden className="absolute inset-x-[-12%] top-1/2 h-px animate-pulse bg-kin/70" />}
              </div>
            </ScanStage>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button variant="inverse" size="md" className="h-[46px] shrink-0 px-6" onClick={restart}>
                <RotateCcwIcon />Capture again
              </Button>
              {step !== "search" && searchBox}
            </div>
          </div>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-6">
        {step === "capture" && (
          <section className="flex flex-col gap-3">
            <PanelHeading>Waiting for a card</PanelHeading>
            <HowRow icon={<ScanEyeIcon />} title="We read the name and set" body="We recognise the card in the frame, Scryfall confirms the exact printing." />
            <HowRow icon={<ListChecksIcon />} title="You check the details" body="Condition, language and finish are yours to set." />
            <HowRow icon={<QrCodeIcon />} title="Scan the owner's QR" body="From the Kura app on their phone." />
            <HowRow icon={<StampIcon />} title="Mint the twin" body="It gets an ENS name and stays in the vault." />
            <StationStats />
          </section>
        )}

        {step === "matching" && (
          <section className="flex flex-col gap-3" aria-busy>
            <PanelHeading aside="matching…">Scryfall match</PanelHeading>
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[78px] rounded-xl" />)}
          </section>
        )}

        {step === "pick" && (
          <section className="flex flex-col gap-3">
            <PanelHeading aside={`${matches.length} ${matches.length === 1 ? "artwork" : "artworks"}`}>Scryfall match</PanelHeading>
            <p className="text-[12px] text-text-2">{confident ? "Best match first. Pick the card:" : <strong className="font-semibold text-shu">Not sure — pick or search</strong>}</p>
            {matches.map((m, i) => (
              <CandidateTile
                key={m.illustrationId}
                c={m}
                highlight={confident && i === 0}
                onPick={() => pickArtwork(m)}
                note={`score ${m.score.toFixed(2)}${m.siblings.length > 1 ? ` · ${m.siblings.length} printings` : ""}`}
              />
            ))}
            <div className="flex flex-wrap gap-2">
              {confident && <Button variant="primary" size="compact" onClick={() => pickArtwork(matches[0])}>Use best match</Button>}
              <Button variant="secondary" size="compact" onClick={() => openSearch(matches[0]?.name ?? "")}>Not it? Search by name</Button>
              <Button variant="ghost" size="compact" onClick={restart}>Rescan</Button>
            </div>
          </section>
        )}

        {step === "search" && (
          <section className="flex flex-col gap-3">
            <PanelHeading aside={searching ? "searching…" : results.length ? `${results.length} printings` : undefined}>Search Scryfall</PanelHeading>
            <SearchInput
              mono
              autoFocus
              aria-label="Search by name"
              placeholder="Search by name"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              kbd="↵"
            />
            {results.length === 0 && !searching && <p className="px-1 text-[12px] text-muted-foreground">Search the card by name.</p>}
            {searching && results.length === 0 && [0, 1, 2].map((i) => <Skeleton key={i} className="h-[78px] rounded-xl" />)}
            {results.map((c) => <CandidateTile key={c.scryfallId} c={c} onPick={() => chooseManual(c)} />)}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="compact" onClick={() => search()} disabled={searching}>{searching ? "Searching…" : "Search"}</Button>
              <Button variant="ghost" size="compact" onClick={restart}>Back to camera</Button>
            </div>
          </section>
        )}

        {step === "edition" && group && (
          <section className="flex flex-col gap-3">
            <PanelHeading aside={`${group.siblings.length} printings`}>Pick the printing</PanelHeading>
            <p className="text-[12px] text-text-2">This artwork appears in {group.siblings.length} printings. Pick the exact edition and language:</p>
            {group.siblings.map((c) => <CandidateTile key={c.scryfallId} c={c} highlight={c.scryfallId === group.scryfallId} onPick={() => choose(c)} />)}
            <div><Button variant="ghost" size="compact" onClick={() => setStep("pick")}>Back to matches</Button></div>
          </section>
        )}

        {detailsOpen && chosen && (
          <section className="flex flex-col gap-3">
            <PanelHeading aside={<button type="button" className="hover:text-text" onClick={() => (matches.length ? setStep("pick") : openSearch(chosen.name))}>Change</button>}>
              Scryfall match
            </PanelHeading>
            <CandidateTile c={chosen} highlight onPick={() => {}} />
          </section>
        )}

        {showForm && (
          <div className={detailsOpen ? "flex flex-col gap-6" : "pointer-events-none flex flex-col gap-6 opacity-40 select-none"} aria-hidden={!detailsOpen || undefined}>
            <section className="flex flex-col gap-2">
              <PanelHeading>Details</PanelHeading>
              <span className="text-[12px] text-text-2">Condition</span>
              <Segmented label="Condition" options={CONDITIONS.map((c) => ({ value: c }))} value={condition} onChange={setCondition} disabled={!detailsOpen} />
              <span className="pt-1 text-[12px] text-text-2">Language</span>
              <Segmented
                label="Language"
                columns={6}
                options={[...new Set([language, ...LANGUAGES])].map((l) => ({ value: l, label: l.toUpperCase() }))}
                value={language}
                onChange={setLanguage}
                disabled={!detailsOpen}
              />
              <span className="pt-1 text-[12px] text-text-2">Finish</span>
              <Segmented
                label="Finish"
                options={[{ value: "nonfoil", label: "Non-foil" }, { value: "foil", label: "Foil" }]}
                value={foil ? "foil" : "nonfoil"}
                onChange={(v) => setFoil(v === "foil")}
                disabled={!detailsOpen}
              />
            </section>

            <section className="flex flex-col gap-2">
              <PanelHeading aside="scan their QR">Owner</PanelHeading>
              {step === "owner" ? (
                <div className="flex flex-col gap-3">
                  <QrScanner onAddress={onQrAddress} />
                  <OwnerHandleInput
                    onUse={(o) => {
                      setOwner(o.address);
                      setOwnerName(o.name);
                      setOwnerSource("handle");
                      setStep("review");
                    }}
                  />
                </div>
              ) : step === "review" && owner ? (
                <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-2"><QrCodeIcon className="size-5" /></span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <AddressName address={owner} knownName={ownerName} avatar={false} copyable={false} maxWidthClassName="max-w-full" />
                    <span className="text-[11px] text-text-2">{shortAddress(owner)} · {ownerSource === "qr" ? "scanned just now" : "typed handle"}</span>
                  </span>
                  <CheckCircle2Icon aria-label="owner set" className="size-5 shrink-0 text-good" />
                  <button type="button" className="text-[12px] text-muted-foreground hover:text-text" onClick={() => setStep("owner")}>Change</button>
                </div>
              ) : (
                <Button variant="secondary" size="md" className="w-full justify-start" onClick={() => setStep("owner")} disabled={step !== "details"}>
                  <QrCodeIcon />Assign owner
                </Button>
              )}
            </section>

            <section className="flex flex-col gap-1.5 rounded-xl border border-border px-4 py-4">
              <span className="text-[12px] text-muted-foreground">Will mint</span>
              <span className="truncate font-mono text-[15px] text-kin">{willMint}</span>
              <span className="text-[11px] text-text-2">
                {owner ? `to ${ownerLabel} · ` : ""}stays in the vault{nextId != null ? " · the id is confirmed once minted" : ""}
              </span>
            </section>

            {step === "review" && chosen && owner && (
              <p className="text-[13px] text-text-2">
                Ready to mint <strong className="font-semibold text-text">{chosen.name}</strong> ({chosen.setCode.toUpperCase()}, {condition}, {language}{foil ? ", foil" : ""}) to <span className="font-mono">{ownerLabel}</span>.
              </p>
            )}
            <TxStepper
              cta="Mint digital twin"
              walletKind={walletKind}
              ctaIcon={<StampIcon />}
              ctaClassName="h-12 text-[15px]"
              title="Minting the twin"
              failedTitle="The mint didn't go through"
              disabled={step !== "review" || !deployed || !chosen || !owner}
              describeError={describeMintError}
              steps={
                chosen && owner
                  ? [
                      {
                        id: "mint",
                        label: `Mint ${chosen.name} to ${ownerLabel}`,
                        run: () =>
                          send({
                            to: addresses.cardVault,
                            abi: abi.cardVault,
                            functionName: "mint",
                            args: [{ to: owner, scryfallId: chosen.scryfallId, slug: chosen.slug, setCode: chosen.setCode, condition, language, imageUrl: chosen.image, description }],
                          }),
                      },
                    ]
                  : []
              }
              onDone={(results) => void onMinted(results)}
            />
            {detailsOpen && <Button variant="ghost" size="compact" className="w-fit" onClick={restart}>Start over</Button>}
          </div>
        )}
      </aside>
    </div>
  );
}
