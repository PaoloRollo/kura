import { describe, expect, it } from "vitest";
import { bidRowId, checkpointId, holderId, logId, tickId } from "../src/lib/ids";

describe("ids", () => {
  it("builds stable ids", () => {
    expect(logId("0xABC", 7)).toBe("0xabc-7");
    expect(holderId("0xToKeN", "0xHoLdEr")).toBe("0xtoken-0xholder");
    expect(bidRowId("0xA", 3n)).toBe("0xa-3");
    expect(tickId("0xA", 100n)).toBe("0xa-100");
    expect(checkpointId("0xA", 100n)).toBe("0xa-100");
  });
});
