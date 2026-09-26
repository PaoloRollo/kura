// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { IndexerConfigBanner } from "@/components/sync-state";
import { indexerConfigError, serverIndexerUrl } from "@/lib/indexer-config";

afterEach(cleanup);

describe("indexer configuration", () => {
  it("is an error only in production without a URL", () => {
    expect(indexerConfigError({ nodeEnv: "production", url: undefined })).toMatch(/indexer not configured/i);
    expect(indexerConfigError({ nodeEnv: "production", url: "" })).toMatch(/NEXT_PUBLIC_PONDER_URL/);
    expect(indexerConfigError({ nodeEnv: "production", url: "https://indexer.example" })).toBeNull();
    expect(indexerConfigError({ nodeEnv: "development", url: undefined })).toBeNull();
  });

  it("refuses the server URL in production without PONDER_URL, and defaults to localhost in development", () => {
    expect(() => serverIndexerUrl({ nodeEnv: "production", url: undefined })).toThrow(/PONDER_URL/);
    expect(serverIndexerUrl({ nodeEnv: "development", url: undefined })).toBe("http://localhost:42069");
    expect(serverIndexerUrl({ nodeEnv: "production", url: "https://i.example" })).toBe("https://i.example");
  });

  it("shows a visible error instead of a spinner", () => {
    render(<IndexerConfigBanner error="Indexer not configured: NEXT_PUBLIC_PONDER_URL is not set." />);
    expect(screen.getByRole("alert").textContent).toMatch(/indexer not configured/i);
    cleanup();
    const { container } = render(<IndexerConfigBanner error={null} />);
    expect(container.textContent).toBe("");
  });
});
