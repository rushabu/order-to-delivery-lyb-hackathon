import { parseSse } from "./stream";

describe("stream hint parser (DESIGN.md 5.8)", () => {
  it("parses change hints, skips keep-alive comments and keeps a partial message for the next chunk", () => {
    const chunk =
      ": keep-alive\n\n" +
      'event: change\ndata: {"entity":"shipment","id":"SHP-1001","version":43,"kinds":["eta","alert"]}\n\n' +
      'event: change\ndata: {"entity":"notif';
    const { hints, rest } = parseSse(chunk);
    expect(hints).toEqual([{ entity: "shipment", id: "SHP-1001", version: 43, kinds: ["eta", "alert"] }]);
    expect(rest).toBe('event: change\ndata: {"entity":"notif');
    const next = parseSse(rest + 'ication"}\n\n');
    expect(next.hints).toEqual([{ entity: "notification" }]);
    expect(next.rest).toBe("");
  });
});
