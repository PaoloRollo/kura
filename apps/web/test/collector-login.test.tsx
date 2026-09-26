// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CollectorLogin } from "@/components/collector-login";

afterEach(cleanup);

describe("CollectorLogin", () => {
  it("promises no gas fees for email and Google only, not for a connected wallet", () => {
    render(<CollectorLogin onLogin={() => {}} />);
    const note = screen.getByText(/no seed phrase/i);
    expect(note.textContent).toMatch(/email or Google/i);
    expect(note.textContent).toMatch(/no gas fees/i);
    expect(screen.getByText(/connected wallet pays its own gas/i)).toBeTruthy();
  });
});
