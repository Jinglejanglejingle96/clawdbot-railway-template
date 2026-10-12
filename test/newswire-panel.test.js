import assert from "node:assert/strict";
import test from "node:test";
import { parseNewswire } from "../src/newspaper/render.js";

test("NEWSWIRE digest text becomes stories with a link, source and impact; Telegram hints are dropped", () => {
  const text = `📰 NEWSWIRE DIGEST — 12 Oct 07:30

1. US forces disable ship in Gulf of Oman
   impact 82 · confidence 97 · 5 independent · first 02:55 · NW-E32FA
   bluesky-news: https://bsky.app/profile/reuters.com/post/3mxkv
2. Cheong Wa Dae urges N. Korea to halt launches
   impact 67 · confidence 88 · 1 independent · first 02:55 · NW-A92BC
   yonhap: https://en.yna.co.kr/view/AEN2026

Reply e.g. 'more like 2', 'less like 3'`;
  const s = parseNewswire(text);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { hed: "US forces disable ship in Gulf of Oman", impact: 82, independent: 5, first: "02:55",
    url: "https://bsky.app/profile/reuters.com/post/3mxkv", via: "reuters.com" });
  assert.equal(s[1].via, "yonhap");
  assert.ok(!s.some((x) => /reply/i.test(x.hed)));
});
