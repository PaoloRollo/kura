// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { releaseFocusForIdkit, watchIdkitLayer } from "@/lib/idkit-layer";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("IDKit layer over a modal sheet", () => {
  it("gives the widget's host pointer events back and keeps its focus and taps from reaching the sheet", async () => {
    watchIdkitLayer();
    const host = document.createElement("div");
    host.setAttribute("data-idkit-shadow-host", "true");
    document.body.appendChild(host);
    await tick(); // MutationObserver
    expect(host.style.pointerEvents).toBe("auto");

    const trap = vi.fn(); // stands in for the sheet's document-level focus trap and outside-click listener
    document.addEventListener("focusin", trap);
    document.addEventListener("pointerdown", trap);
    const button = document.createElement("button");
    host.attachShadow({ mode: "open" }).appendChild(button);
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    button.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(trap).not.toHaveBeenCalled();

    // Events elsewhere still reach the document.
    document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(trap).toHaveBeenCalledTimes(1);
  });

  it("releases focus from the sheet's input before the widget opens", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    releaseFocusForIdkit();
    expect(document.activeElement).not.toBe(input);
  });
});
