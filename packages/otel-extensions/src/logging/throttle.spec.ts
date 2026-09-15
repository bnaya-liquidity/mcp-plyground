import { defaultNormalize } from "./throttle.js";

describe("defaultNormalize", () => {
  it("gives two lines differing only by timestamp the same signature", () => {
    const a = defaultNormalize("2026-07-20T12:12:46.204+00:00 export failed");
    const b = defaultNormalize("2026-07-20T09:00:00.000+00:00 export failed");
    expect(a).toBe(b);
    expect(a).toBe("<ts> export failed");
  });

  it("strips UUIDs", () => {
    expect(defaultNormalize("run 3f2504e0-4f89-41d3-9a0c-0305e82c3301 failed")).toBe(
      "run <uuid> failed",
    );
  });

  it("strips multi-digit runs (e.g. gRPC status codes)", () => {
    expect(defaultNormalize("Error: 14 UNAVAILABLE")).toBe("Error: <n> UNAVAILABLE");
  });

  it("strips long hex runs", () => {
    expect(defaultNormalize("span deadbeefcafe1234 dropped")).toBe("span <hex> dropped");
  });

  it("collapses whitespace and trims", () => {
    expect(defaultNormalize("  a   b  ")).toBe("a b");
  });
});

import { throttle, type ThrottleEmit } from "./throttle.js";
import { jest } from "@jest/globals";

function makeEmit(): ThrottleEmit & {
  pass: jest.Mock<ThrottleEmit["pass"]>;
  notice: jest.Mock<ThrottleEmit["notice"]>;
} {
  return {
    pass: jest.fn<ThrottleEmit["pass"]>(),
    notice: jest.fn<ThrottleEmit["notice"]>(),
  };
}

const CFG = {
  threshold: 3,
  windowMs: 1_000,
  flushIntervalMs: 5_000,
  flushCount: 4,
  quietMs: 10_000,
};

describe("throttle", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("passes lines through while closed (below threshold)", () => {
    const emit = makeEmit();
    const log = throttle(emit, CFG);
    log("boom");
    log("boom");
    expect(emit.pass).toHaveBeenCalledTimes(2);
    expect(emit.notice).not.toHaveBeenCalled();
  });

  it("opens on the threshold-th hit and stops passing", () => {
    const emit = makeEmit();
    const log = throttle(emit, CFG);
    log("boom");
    log("boom");
    log("boom"); // 3rd = threshold → open
    expect(emit.pass).toHaveBeenCalledTimes(2);
    expect(emit.notice).toHaveBeenCalledTimes(1);
    expect(emit.notice.mock.calls[0]![1]).toMatchObject({ throttle_event: "open" });
  });

  it("suppresses while open and emits a count-based aggregate", () => {
    const emit = makeEmit();
    const log = throttle(emit, CFG);
    for (let i = 0; i < 3; i++) log("boom"); // open
    emit.notice.mockClear();
    for (let i = 0; i < 4; i++) log("boom"); // flushCount=4 → one aggregate
    expect(emit.pass).toHaveBeenCalledTimes(2); // unchanged since opening
    const agg = emit.notice.mock.calls.find((c) => c[1].throttle_event === "aggregate");
    expect(agg?.[1]).toMatchObject({ suppressed: 4, throttle_event: "aggregate" });
  });

  it("emits a time-based aggregate while open even without new hits reaching flushCount", () => {
    const emit = makeEmit();
    const log = throttle(emit, CFG);
    for (let i = 0; i < 3; i++) log("boom"); // open
    log("boom"); // 1 suppressed, below flushCount
    emit.notice.mockClear();
    jest.advanceTimersByTime(CFG.flushIntervalMs); // sweep fires
    expect(emit.notice.mock.calls.some((c) => c[1].throttle_event === "aggregate")).toBe(
      true,
    );
  });

  it("closes after a quiet period and passes again", () => {
    const emit = makeEmit();
    const log = throttle(emit, CFG);
    for (let i = 0; i < 3; i++) log("boom"); // open
    jest.advanceTimersByTime(CFG.quietMs); // no hits → close (evicts the circuit)
    expect(emit.notice.mock.calls.some((c) => c[1].throttle_event === "close")).toBe(
      true,
    );
    emit.pass.mockClear();
    log("boom"); // reopened cycle starts closed
    expect(emit.pass).toHaveBeenCalledTimes(1);

    // The evicted circuit is recreated fresh on next use, so it can trip open
    // again exactly like a brand-new signature would (threshold-th hit reopens).
    emit.notice.mockClear();
    log("boom");
    log("boom"); // 3rd hit total since eviction → threshold → reopens
    expect(emit.notice.mock.calls.some((c) => c[1].throttle_event === "open")).toBe(true);
  });

  it("keeps distinct signatures independent", () => {
    const emit = makeEmit();
    const log = throttle(emit, CFG);
    for (let i = 0; i < 3; i++) log("alpha");
    log("beta");
    expect(emit.pass).toHaveBeenCalledWith("beta");
  });

  it("uses an explicit key to group otherwise-distinct messages", () => {
    const emit = makeEmit();
    const log = throttle(emit, CFG);
    log("first text", "same-key");
    log("second text", "same-key");
    log("third text", "same-key"); // threshold → open under the shared key
    expect(emit.notice.mock.calls[0]![1]).toMatchObject({
      throttle_signature: "same-key",
    });
  });
});
