/**
 * Collapses a raw log line to a stable signature by replacing its dynamic parts
 * (timestamps, UUIDs, long hex runs, multi-digit runs) with placeholders, so
 * repeats of "the same" line hash together. Order matters: timestamps and UUIDs
 * are stripped before the generic hex/digit passes that would otherwise chew
 * them up piecemeal.
 */
export function defaultNormalize(message: string): string {
  return message
    .replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      "<ts>",
    )
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b\d{2,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ThrottleConfig {
  /** Hits within windowMs that trip the circuit open. Default 5. */
  threshold: number;
  /** Rolling window for the threshold. Default 10_000 ms. */
  windowMs: number;
  /** While open, emit an aggregate at least every this many ms. Default 30_000. */
  flushIntervalMs: number;
  /** While open, also emit an aggregate every this many suppressed hits. Default 100. */
  flushCount: number;
  /** No hits for this long → close (with a final summary). Default 60_000 ms. */
  quietMs: number;
  /** Severity label of the wrapped site; surfaced as `original_level` in notices. */
  level: string;
  /** Signature extractor; defaults to {@link defaultNormalize}. */
  normalize: (message: string) => string;
}

export interface ThrottleNoticeAttrs {
  throttle_event: "open" | "aggregate" | "close";
  throttle_signature: string;
  suppressed: number;
  total_suppressed: number;
  window_ms: number;
  sample?: string;
  original_level: string;
}

/** How a throttle emits: the original line, and its own WARN meta-logs. */
export interface ThrottleEmit {
  /** Emit the original line at its original level (closed, pass-through). */
  pass: (message: string) => void;
  /** Emit a throttle meta-event (open/aggregate/close) — the caller logs it at WARN. */
  notice: (message: string, attrs: ThrottleNoticeAttrs) => void;
}

const DEFAULTS: ThrottleConfig = {
  threshold: 5,
  windowMs: 10_000,
  flushIntervalMs: 30_000,
  flushCount: 100,
  quietMs: 60_000,
  level: "error",
  normalize: defaultNormalize,
};

/** How often the shared sweeper checks open circuits for time-based flush/close. */
const SWEEP_INTERVAL_MS = 1_000;

interface Circuit {
  open: boolean;
  windowStart: number;
  windowHits: number;
  suppressed: number;
  totalSuppressed: number;
  lastHit: number;
  lastFlush: number;
  sample: string;
}

/**
 * Wraps a log sink so that a burst of near-identical lines trips a per-signature
 * "circuit": once open, individual lines are suppressed (protecting readability
 * and downstream quota) while a periodic aggregate preserves the fact — and
 * count — of the storm. Opt-in per site; the returned function is called once per
 * occurrence, with an optional explicit dedup `key`.
 *
 * One `unref()`'d interval per throttle instance handles time-based flush and
 * auto-close (not one timer per signature); it is created lazily when the first
 * circuit opens and cleared when none remain open, so it never blocks exit.
 */
export function throttle(
  emit: ThrottleEmit,
  config: Partial<ThrottleConfig> = {},
): (message: string, key?: string) => void {
  const cfg: ThrottleConfig = { ...DEFAULTS, ...config };
  const circuits = new Map<string, Circuit>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const attrs = (
    event: ThrottleNoticeAttrs["throttle_event"],
    sig: string,
    c: Circuit,
  ): ThrottleNoticeAttrs => ({
    throttle_event: event,
    throttle_signature: sig,
    suppressed: c.suppressed,
    total_suppressed: c.totalSuppressed,
    window_ms: cfg.windowMs,
    sample: c.sample,
    original_level: cfg.level,
  });

  const flush = (sig: string, c: Circuit, now: number): void => {
    if (c.suppressed > 0) {
      emit.notice(
        `[throttled] ${sig} ×${c.suppressed} in last ${now - c.lastFlush}ms (total ${c.totalSuppressed})`,
        attrs("aggregate", sig, c),
      );
      c.suppressed = 0;
    }
    c.lastFlush = now;
  };

  const sweep = (now: number): void => {
    let anyOpen = false;
    for (const [sig, c] of circuits) {
      if (!c.open) continue;
      if (now - c.lastFlush >= cfg.flushIntervalMs) flush(sig, c, now);
      if (now - c.lastHit >= cfg.quietMs) {
        flush(sig, c, now);
        emit.notice(
          `[throttled] ${sig} closed (total ${c.totalSuppressed} suppressed)`,
          attrs("close", sig, c),
        );
        // Evict rather than reset-and-retain: this is a reusable primitive fed
        // high-cardinality explicit keys, so a closed circuit must not linger in
        // the map forever. A later hit for the same signature simply recreates a
        // fresh closed circuit (see the `circuits.get(sig) === undefined` branch
        // below) — behavior is equivalent. Deleting the current key mid-iteration
        // is safe: Map iteration tolerates deletion of the entry just visited.
        circuits.delete(sig);
      } else {
        anyOpen = true;
      }
    }
    if (!anyOpen && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const ensureTimer = (): void => {
    if (timer !== undefined) return;
    timer = setInterval(() => sweep(Date.now()), SWEEP_INTERVAL_MS);
    timer.unref?.();
  };

  return (message: string, key?: string): void => {
    const now = Date.now();
    const sig = key ?? cfg.normalize(message);
    let c = circuits.get(sig);
    if (c === undefined) {
      c = {
        open: false,
        windowStart: now,
        windowHits: 0,
        suppressed: 0,
        totalSuppressed: 0,
        lastHit: now,
        lastFlush: now,
        sample: message,
      };
      circuits.set(sig, c);
    }
    c.lastHit = now;
    c.sample = message;

    if (!c.open) {
      if (now - c.windowStart > cfg.windowMs) {
        c.windowStart = now;
        c.windowHits = 0;
      }
      c.windowHits += 1;
      if (c.windowHits >= cfg.threshold) {
        c.open = true;
        c.suppressed = 0;
        c.totalSuppressed = 0;
        c.lastFlush = now;
        emit.notice(
          `[throttled] ${sig} opened after ${cfg.threshold} in ${cfg.windowMs}ms`,
          attrs("open", sig, c),
        );
        ensureTimer();
      } else {
        emit.pass(message);
      }
    } else {
      c.suppressed += 1;
      c.totalSuppressed += 1;
      if (c.suppressed >= cfg.flushCount) flush(sig, c, now);
    }
  };
}
