import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { McpRequestContextMiddleware } from "./mcp-request-context.middleware.js";
import { getMcpRequestContext, getRequestHeader } from "./mcp-request-context.js";

describe("McpRequestContextMiddleware", () => {
  it("binds headers and the raw response for everything run inside next()", async () => {
    const req = new IncomingMessage(new Socket());
    req.headers = { "x-trace": "abc" };
    const res = new ServerResponse(req);

    const seen = await new Promise<{ res: ServerResponse | undefined; header: string | undefined }>(
      (resolve) => {
        new McpRequestContextMiddleware().use(req, res, () => {
          // Read after an async hop, the way a detached job would.
          setImmediate(() =>
            resolve({ res: getMcpRequestContext()?.res, header: getRequestHeader("X-Trace") }),
          );
        });
      },
    );

    expect(seen.res).toBe(res);
    expect(seen.header).toBe("abc");
  });

  it("leaves no context behind once next() returns", () => {
    const req = new IncomingMessage(new Socket());
    new McpRequestContextMiddleware().use(req, new ServerResponse(req), () => undefined);
    expect(getMcpRequestContext()).toBeUndefined();
  });
});
