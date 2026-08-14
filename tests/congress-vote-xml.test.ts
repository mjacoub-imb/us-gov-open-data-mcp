/**
 * `parseXml` (src/apis/congress/sdk.ts) parses House/Senate roll-call vote
 * XML from clerk.house.gov / senate.gov. It previously set
 * `processEntities: false` as defense-in-depth against DTD/custom entity
 * expansion — but fast-xml-parser's `processEntities` flag gates ALL entity
 * decoding, including the five predefined XML entities (&amp; &lt; &gt;
 * &quot; &apos;), not just custom/DTD ones. That silently corrupted any
 * vote title/question/description containing "&amp;" (extremely common,
 * e.g. "Armed Services & Veterans Affairs").
 *
 * fast-xml-parser (v5, see node_modules/fast-xml-parser/src/xmlparser/
 * DocTypeReader.js readEntityExp) already hard-rejects external (SYSTEM) and
 * parameter (%) entities regardless of processEntities, and refuses to
 * register any internal entity whose value itself contains "&" — so
 * classic XXE/entity-bomb vectors aren't reachable here even with entity
 * processing left on. That's what makes leaving it on the safe choice.
 */

import { describe, it, expect } from "vitest";
import { parseXml } from "../src/apis/congress/sdk.js";

describe("congress: parseXml entity decoding", () => {
  it("decodes standard predefined XML entities in element text", () => {
    const xml = `<?xml version="1.0"?><roll_call_vote><vote_title>Armed Services &amp; Veterans Affairs</vote_title></roll_call_vote>`;
    const parsed = parseXml<{ roll_call_vote: { vote_title: string } }>(xml);
    expect(parsed.roll_call_vote.vote_title).toBe("Armed Services & Veterans Affairs");
  });

  it("decodes &lt; and &gt; in element text", () => {
    const xml = `<?xml version="1.0"?><roll_call_vote><question>H.R. 1 &lt; H.R. 2 &gt; H.R. 3</question></roll_call_vote>`;
    const parsed = parseXml<{ roll_call_vote: { question: string } }>(xml);
    expect(parsed.roll_call_vote.question).toBe("H.R. 1 < H.R. 2 > H.R. 3");
  });

  it("does not expand external (SYSTEM) entities", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE roll_call_vote [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><roll_call_vote><vote_title>&xxe;</vote_title></roll_call_vote>`;
    expect(() => parseXml(xml)).toThrow();
  });
});
