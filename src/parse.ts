// Parses the model's JSON answer. The answer is tried as-is first: review
// comments may themselves contain ```suggestion fences, so a markdown fence
// is only stripped when it wraps the whole answer, and the outermost {...}
// is the last resort for a model that adds a sentence around the JSON.
export function parseJsonAnswer(raw: string): unknown {
  const text = raw.trim();
  const candidates = [text];

  const wrapped = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (wrapped) {
    candidates.push(wrapped[1]);
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(text.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}
