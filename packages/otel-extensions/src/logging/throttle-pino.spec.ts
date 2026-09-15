import { jest } from "@jest/globals";
import type { Logger } from "pino";
import { throttleWithPino } from "./throttle-pino.js";
import type { ThrottleNoticeAttrs } from "./throttle.js";

function fakeLogger() {
  return {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  };
}

const ATTRS: ThrottleNoticeAttrs = {
  throttle_event: "open",
  throttle_signature: "sig",
  suppressed: 0,
  total_suppressed: 0,
  window_ms: 1000,
  original_level: "error",
};

describe("throttleWithPino", () => {
  it("passes at the requested level", () => {
    const logger = fakeLogger();
    const emit = throttleWithPino(logger as unknown as Logger, "debug");
    emit.pass("hello");
    expect(logger.debug).toHaveBeenCalledWith("hello");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("defaults the pass level to error", () => {
    const logger = fakeLogger();
    const emit = throttleWithPino(logger as unknown as Logger);
    emit.pass("boom");
    expect(logger.error).toHaveBeenCalledWith("boom");
  });

  it("emits notices at WARN with the attrs as structured fields", () => {
    const logger = fakeLogger();
    const emit = throttleWithPino(logger as unknown as Logger, "error");
    emit.notice("opened", ATTRS);
    expect(logger.warn).toHaveBeenCalledWith(ATTRS, "opened");
  });
});
