import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/migrate";
import { setUserForTests } from "@/lib/auth";
import deployments from "@/generated/deployments.json";
import { runScan } from "@/lib/scan";
import { ScryfallUnavailableError } from "@/lib/scryfall";
import { RecognitionUnavailableError, recognizeCard } from "@/lib/vision";

const vendor = deployments.vendor as `0x${string}`;
const candidate = { scryfallId: "id1", name: "Black Lotus", printedName: null, lang: "en", set: "lea", setName: "Alpha", collectorNumber: "232", rarity: "rare", image: "i", imageSmall: "s", prices: { usd: "1", usdFoil: null, eur: null }, finishes: ["nonfoil"], slug: "black-lotus", setCode: "lea" };
const body = { image: "data:image/jpeg;base64,AAAA", mediaType: "image/jpeg" as const };

describe("runScan", () => {
  beforeEach(async () => {
    await createTestDb();
    setUserForTests({ did: "did:vendor", wallet: vendor });
  });

  it("recognises, resolves and stores a draft", async () => {
    const recognize = vi.fn(async () => ({ name: "Black Lotus", setHint: "lea", collectorNumber: null, language: "en", foil: false, confidence: 0.9 }));
    const named = vi.fn(async () => candidate);
    const out = await runScan(body, { did: "did:vendor", wallet: vendor }, { recognize, scryfall: { named, search: vi.fn(async () => []) } });
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].slug).toBe("black-lotus");
    expect(out.draftId).toMatch(/[0-9a-f-]{36}/);
    expect(recognize).toHaveBeenCalledWith(expect.objectContaining({ imageBase64: "AAAA", mediaType: "image/jpeg" }));
    expect(named).toHaveBeenCalledWith({ name: "Black Lotus", set: "lea", lang: "en" });
  });

  it("falls back to search when the pinned printing is missing, and returns empty candidates when nothing matches", async () => {
    const recognize = vi.fn(async () => ({ name: "Black Lotus", setHint: "xyz", collectorNumber: null, language: "en", foil: false, confidence: 0.5 }));
    const scryfall = { named: vi.fn(async () => null), search: vi.fn(async () => [candidate, candidate, candidate, candidate]) };
    const out = await runScan(body, { did: "did:vendor", wallet: vendor }, { recognize, scryfall });
    expect(out.candidates).toHaveLength(3);
    expect(scryfall.search).toHaveBeenCalledWith('!"Black Lotus" unique:prints', 3);

    const none = await runScan(body, { did: "did:vendor", wallet: vendor }, { recognize, scryfall: { named: vi.fn(async () => null), search: vi.fn(async () => []) } });
    expect(none.candidates).toEqual([]);
    expect(none.recognition.name).toBe("Black Lotus");
  });

  it("maps upstream failures to stable codes and blocks non-vendors", async () => {
    const boom = vi.fn(async () => { throw new RecognitionUnavailableError("refused"); });
    await expect(runScan(body, { did: "did:vendor", wallet: vendor }, { recognize: boom, scryfall: { named: vi.fn(), search: vi.fn() } })).rejects.toMatchObject({ code: "RECOGNITION_UNAVAILABLE", status: 503 });

    const recognize = vi.fn(async () => ({ name: "x", setHint: null, collectorNumber: null, language: "en", foil: false, confidence: 1 }));
    const down = { named: vi.fn(async () => { throw new ScryfallUnavailableError(); }), search: vi.fn() };
    await expect(runScan(body, { did: "did:vendor", wallet: vendor }, { recognize, scryfall: down })).rejects.toMatchObject({ code: "SCRYFALL_UNAVAILABLE", status: 503 });

    await expect(runScan(body, { did: "did:alice", wallet: "0x1111111111111111111111111111111111111111" }, { recognize, scryfall: down })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });
});

describe("recognizeCard", () => {
  it("reports a missing API key as RecognitionUnavailableError without calling out", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(recognizeCard({ imageBase64: "AAAA", mediaType: "image/jpeg" })).rejects.toBeInstanceOf(RecognitionUnavailableError);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
