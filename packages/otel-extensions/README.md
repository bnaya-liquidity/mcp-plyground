# @playground/otel-extensions

## Consumer spans (async hops carry links, not parent-child)

`withConsumerSpan` opens the span for work pulled off a queue or topic — the one
span auto-instrumentation cannot produce, because nothing else knows a poll
returned work or which producer it came from.

```ts
import { createSpanHelpers } from "@playground/otel-extensions";

const { withConsumerSpan } = createSpanHelpers("orders-worker");

await withConsumerSpan(
  { destination: "orders", headers: message.headers, system: "aws_sqs" },
  async () => handle(message.body),
);
```

It opens a **root** `CONSUMER` span carrying a **link** to the producer, never a
child of it. That is deliberate:

- A parent span cannot end until its children do, so parent-child turns a
  four-hour queue wait into a four-hour root span — and every latency percentile
  the collector's `span_metrics` connector derives from it is then garbage.
- Fan-out has no single parent (one publish, five consumers; 100 messages in one
  poll). Links are many-to-many; parenthood is not.
- The producer's span was exported and made immutable long before the consumer
  started.

The span name is built as `` `${operation} ${destination}` `` from the options
rather than accepted as a free string: `span_metrics` keys on span name, so a
caller-supplied name is the one place a message id can leak in and turn every
message into its own metric series.

**A batch** passes an array of headers and gets ONE span with one link per
message plus `messaging.batch.message_count`:

```ts
await withConsumerSpan(
  { destination: "orders", headers: batch.map((m) => m.headers) },
  async () => handleAll(batch),
);
```

**The exception worth naming:** a *synchronous* request/reply over a queue, where
the caller blocks on the response, genuinely is parent-child. Use `withAsyncSpan`
there, not this.

For transports no instrumentation covers, `extractLink(headers)` and
`injectContext(headers)` expose the same plumbing directly. For an **outbox
table**, the injected `traceparent` must be written in the same transaction as
the row it describes — context written outside that transaction goes missing in
exactly the failure cases you need it for.

## Log throttle (circuit breaker)

`throttle()` bounds bursts of near-identical log lines: after `threshold` hits in
`windowMs` it "opens" and suppresses repeats, emitting a periodic WARN aggregate
(every `flushIntervalMs` or `flushCount` hits) and a WARN on open and close — so a
storm stays visible and counted without flooding the stream or downstream quota.
It is **opt-in per log site** and depends only on the standard library.

Logger-neutral (any sink):

```ts
import { throttle } from "@playground/otel-extensions";

const warnStorm = throttle({
  pass: (msg) => console.error(msg),
  notice: (msg, attrs) => console.warn(msg, attrs),
});

warnStorm("upstream 14 UNAVAILABLE"); // repeats collapse into an aggregate
```

With pino (convenience adapter):

```ts
import pino from "pino";
import { throttle, throttleWithPino } from "@playground/otel-extensions";

const logger = pino();
const throttled = throttle(throttleWithPino(logger, "error"), { level: "error" });
throttled("upstream 14 UNAVAILABLE");
```

Dedup key: by default the message is normalised (timestamps/UUIDs/hex/digits are
stripped — see `defaultNormalize`) to a signature; pass an explicit second
argument (`throttled(msg, "my-key")`) when you already know it.

## Log level: the floor is `LOG_LEVEL`, and it defaults to `debug`

`buildPinoLoggerOptions()` sets `level: process.env.LOG_LEVEL ?? "debug"`, and
that level is now the **only** filter — it applies to stdout and to the OTLP log
stream alike. Nothing in this repo sets `LOG_LEVEL`, so an unconfigured service
emits DEBUG and above.

**This changed as of the fix below, and it changes log volume.** Until then,
`buildPinoDestination()` built its `pino.multistream` without a per-stream
`level`, and `pino.multistream` filters a **second** time on write, defaulting
each stream to `info`. So the documented `debug` default was inert: every record
below INFO was discarded on both arms at once — missing from stdout *and* from
the OTLP log stream, with no error, no warning, and nothing in a unit test that
could see it. Any service relying on a DEBUG line reaching a backend never got
one.

Both arms are now pinned to `level: "trace"` so the logger's own `level` is what
decides, which restores the documented and unit-tested intent.

The consequence is real: **a service picking up this release sees its effective
log floor move from INFO to DEBUG**, on stdout and in the OTLP stream, unless it
says otherwise. To keep the previous volume, set it explicitly:

```bash
LOG_LEVEL=info
```

Set it wherever the service's environment is configured — this library
deliberately does not choose a floor on a deployment's behalf.
