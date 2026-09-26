// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CollectorLogin } from "@/components/collector-login";

afterEach(cleanup);

describe("CollectorLogin", () => {
  it("offers email and a connected wallet, and no Google login", () => {
    render(<CollectorLogin onLogin={() => {}} />);
    expect(screen.getByRole("button", { name: /continue with email/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /connect a wallet/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /google/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/google/i);
  });

  it("promises no gas fees for email only, not for a connected wallet", () => {
    render(<CollectorLogin onLogin={() => {}} />);
    const note = screen.getByText(/no seed phrase/i);
    expect(note.textContent).toMatch(/with email/i);
    expect(note.textContent).toMatch(/no gas fees/i);
    expect(screen.getByText(/connected wallet pays its own gas/i)).toBeTruthy();
  });
});
