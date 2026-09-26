// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AnalyticsPage from "@/app/app/analytics/page";

afterEach(cleanup);

describe("/app/analytics", () => {
  it("is a placeholder that links to Explore and Portfolio", () => {
    render(<AnalyticsPage />);
    expect(screen.getByRole("heading", { name: /vault analytics are on their way/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /explore/i }).getAttribute("href")).toBe("/app");
    expect(screen.getByRole("link", { name: /portfolio/i }).getAttribute("href")).toBe("/app/portfolio");
  });
});
