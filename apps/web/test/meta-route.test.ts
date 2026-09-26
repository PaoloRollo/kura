import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ponder-server", async () => {
  const schema = await import("../../indexer/ponder.schema");
  const chain = { from: () => chain, where: () => chain, limit: async () => { throw new Error("fetch failed"); } };
  return { schema, ponderServer: () => ({ db: { select: () => chain } }) };
});

import { GET } from "@/app/api/meta/[id]/route";

describe("GET /api/meta/[id]", () => {
  it("answers 503, not 500, when the indexer is down", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await GET(new Request("http://x/api/meta/1"), { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("UNAVAILABLE");
    err.mockRestore();
  });
});
