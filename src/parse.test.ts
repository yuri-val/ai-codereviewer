import { test } from "node:test";
import assert from "node:assert";
import { parseJsonAnswer } from "./parse";

const review = {
  reviews: [
    {
      file: "a.ts",
      lineNumber: 3,
      severity: "major",
      reviewComment: "Missing await.\n```suggestion\nconst x = await f();\n```",
    },
  ],
};

test("plain JSON whose comment contains a suggestion fence", () => {
  assert.deepStrictEqual(parseJsonAnswer(JSON.stringify(review)), review);
});

test("JSON wrapped in a json fence, with a suggestion inside", () => {
  const raw = "```json\n" + JSON.stringify(review, null, 2) + "\n```";
  assert.deepStrictEqual(parseJsonAnswer(raw), review);
});

test("JSON with a sentence around it", () => {
  assert.deepStrictEqual(
    parseJsonAnswer("Here you go:\n" + JSON.stringify(review) + "\nDone."),
    review,
  );
});

test("garbage is undefined, not an exception", () => {
  assert.strictEqual(parseJsonAnswer("no json here"), undefined);
  assert.strictEqual(parseJsonAnswer("```suggestion\nx\n```"), undefined);
});
