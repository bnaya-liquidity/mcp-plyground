import type { Logger } from "pino";
import type { ThrottleEmit, ThrottleNoticeAttrs } from "./throttle.js";

/** pino level a throttled site's pass-through lines are logged at. */
export type PinoThrottleLevel = "error" | "warn" | "info" | "debug";

/**
 * Builds a {@link ThrottleEmit} backed by a pino logger: pass-through lines at
 * `level`, and throttle meta-events (open/aggregate/close) at WARN with the
 * structured attrs merged in. This is the only throttle module that imports pino;
 * consumers on other loggers implement `ThrottleEmit` directly.
 */
export function throttleWithPino(
  logger: Logger,
  level: PinoThrottleLevel = "error",
): ThrottleEmit {
  return {
    pass: (message: string): void => {
      logger[level](message);
    },
    notice: (message: string, attrs: ThrottleNoticeAttrs): void => {
      logger.warn(attrs, message);
    },
  };
}
