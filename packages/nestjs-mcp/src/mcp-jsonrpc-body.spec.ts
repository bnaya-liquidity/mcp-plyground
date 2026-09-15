import { describe, expect, it } from "@jest/globals";
import { parseMcpBody } from "./mcp-jsonrpc-body.js";

describe("parseMcpBody", () => {
  it("reads the method of a plain request", () => {
    expect(parseMcpBody({ jsonrpc: "2.0", method: "tools/list", id: 1 })).toEqual({
      method: "tools/list",
    });
  });

  it("reads the tool name of a tools/call", () => {
    const body = { jsonrpc: "2.0", method: "tools/call", params: { name: "add" }, id: 1 };
    expect(parseMcpBody(body)).toEqual({ method: "tools/call", toolName: "add" });
  });

  it("reads clientInfo from an initialize request", () => {
    const body = {
      jsonrpc: "2.0",
      method: "initialize",
      params: { clientInfo: { name: "claude-code", version: "3.1.0" } },
      id: 1,
    };
    expect(parseMcpBody(body)).toEqual({
      method: "initialize",
      clientInfo: { name: "claude-code", version: "3.1.0" },
    });
  });

  it("omits clientInfo when it is malformed", () => {
    const body = { method: "initialize", params: { clientInfo: { name: 7 } } };
    expect(parseMcpBody(body)).toEqual({ method: "initialize" });
  });

  it.each([undefined, null, "a string", 42, [], {}, { method: 7 }])(
    "returns an empty summary for non-MCP body %p",
    (body) => {
      expect(parseMcpBody(body)).toEqual({});
    },
  );
});
