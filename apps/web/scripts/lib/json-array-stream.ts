/**
 * Stream the objects of a top-level JSON array (such as a Scryfall bulk file) without holding the
 * whole document: only the object being read is buffered. Assumes the elements are objects or arrays.
 */
export async function* parseJsonArray(source: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let started = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let carry = "";
  for await (const bytes of source) {
    const s = decoder.decode(bytes, { stream: true });
    let start = depth > 0 ? 0 : -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (!started) {
        if (c === "[") started = true;
        else if (c.trim() !== "") throw new Error("expected a JSON array");
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{" || c === "[") {
        if (depth === 0) start = i;
        depth++;
      } else if (c === "}" || c === "]") {
        if (depth === 0) return; // the closing bracket of the top-level array
        depth--;
        if (depth === 0) {
          yield JSON.parse(carry + s.slice(start, i + 1));
          carry = "";
          start = -1;
        }
      }
    }
    if (depth > 0) carry += s.slice(start);
  }
  if (!started) throw new Error("expected a JSON array");
}
