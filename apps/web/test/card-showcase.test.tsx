// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CardShowcase, tiltAt } from "@/components/card-showcase";

afterEach(cleanup);

const cert = { name: "Black Lotus", set: "LEA", rarity: "Rare", condition: "NM", language: "EN", ensName: "black-lotus-lea-1.kura.eth", released: false };

describe("tiltAt", () => {
  it("is flat at the centre and tilts toward the pointer at the edges, with the glare under the pointer", () => {
    expect(tiltAt(50, 50, 100, 100)).toEqual({ rx: 0, ry: 0, gx: 50, gy: 50 });
    const topRight = tiltAt(100, 0, 100, 100);
    expect(topRight.ry).toBeGreaterThan(0); // right edge comes toward the viewer
    expect(topRight.rx).toBeGreaterThan(0); // top edge comes toward the viewer
    expect(topRight).toMatchObject({ gx: 100, gy: 0 });
    expect(Math.abs(tiltAt(0, 100, 100, 100).rx)).toBeLessThanOrEqual(10);
  });

  it("clamps a pointer outside the card and survives a zero-size box", () => {
    expect(tiltAt(500, -500, 100, 100)).toEqual(tiltAt(100, 0, 100, 100));
    expect(tiltAt(10, 10, 0, 0)).toEqual({ rx: 0, ry: 0, gx: 50, gy: 50 });
  });
});

describe("CardShowcase", () => {
  it("shows the art and flips to the vault certificate on click, and back again", () => {
    render(<CardShowcase src="/cards/black-lotus.webp" alt="Black Lotus" finish="nonfoil" certificate={cert} />);
    const button = screen.getByRole("button", { name: /show vault certificate/i });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toMatch(/show card art/i);
    const back = screen.getByTestId("card-back");
    for (const t of ["Black Lotus", "black-lotus-lea-1.kura.eth", "NM", "EN", "LEA", "Non-foil"]) expect(back.textContent).toContain(t);
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("puts the holographic sheen and a Foil pill only on foil and etched cards", () => {
    const { container, rerender } = render(<CardShowcase src="/a.webp" alt="a" finish="nonfoil" certificate={cert} />);
    expect(container.querySelector("[data-foil]")).toBeNull();
    const pill = () => container.querySelector('[data-slot="finish-pill"]')?.textContent ?? null;
    expect(pill()).toBeNull();
    rerender(<CardShowcase src="/a.webp" alt="a" finish="foil" certificate={cert} />);
    expect(container.querySelector('[data-foil="foil"]')).toBeTruthy();
    expect(pill()).toBe("Foil");
    rerender(<CardShowcase src="/a.webp" alt="a" finish="etched" certificate={cert} />);
    expect(container.querySelector('[data-foil="etched"]')).toBeTruthy();
    expect(pill()).toBe("Etched foil");
  });

  it("says a released card has left the vault", () => {
    render(<CardShowcase src="/a.webp" alt="a" finish="nonfoil" certificate={{ ...cert, released: true }} />);
    expect(screen.getByTestId("card-back").textContent).toMatch(/released from the kura vault/i);
  });
});
