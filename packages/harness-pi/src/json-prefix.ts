import { setImmediate as yieldToLoop } from "node:timers/promises";

type State =
  | "value" | "done"
  | "key-or-end" | "key" | "colon" | "object-value" | "object-separator"
  | "array-value-or-end" | "array-value" | "array-separator";
type NumberState = "minus" | "zero" | "integer" | "dot" | "fraction" | "exponent" | "sign" | "digits";

/** 判断失败的 JSON 是否仍是合法 JSON 的真前缀，不依赖 V8 的错误文案。 */
export async function isIncompleteJson(text: string): Promise<boolean> {
  const stack: State[] = ["value"];
  let mode: "syntax" | "string" | "escape" | "unicode" | "literal" | "number" = "syntax";
  let key = false;
  let unicodeLeft = 0;
  let literal = "";
  let literalAt = 0;
  let number: NumberState = "integer";
  let work = 0;

  for (let i = 0; i < text.length;) {
    if (++work % 65536 === 0) await yieldToLoop();
    const c = text[i];
    if (mode === "string") {
      i++;
      if (c === '"') {
        mode = "syntax";
        if (key) stack[stack.length - 1] = "colon";
      } else if (c === "\\") {
        mode = "escape";
      } else if (c.charCodeAt(0) < 0x20) {
        return false;
      }
      continue;
    }
    if (mode === "escape") {
      i++;
      if (c === "u") {
        mode = "unicode";
        unicodeLeft = 4;
      } else if ('"\\/bfnrt'.includes(c)) {
        mode = "string";
      } else {
        return false;
      }
      continue;
    }
    if (mode === "unicode") {
      if (!/[0-9a-fA-F]/.test(c)) return false;
      i++;
      if (--unicodeLeft === 0) mode = "string";
      continue;
    }
    if (mode === "literal") {
      if (c !== literal[literalAt]) return false;
      i++;
      if (++literalAt === literal.length) mode = "syntax";
      continue;
    }
    if (mode === "number") {
      let next: NumberState | undefined;
      switch (number) {
        case "minus": next = c === "0" ? "zero" : /[1-9]/.test(c) ? "integer" : undefined; break;
        case "zero": next = c === "." ? "dot" : /[eE]/.test(c) ? "exponent" : undefined; break;
        case "integer": next = /[0-9]/.test(c) ? "integer" : c === "." ? "dot" : /[eE]/.test(c) ? "exponent" : undefined; break;
        case "dot": next = /[0-9]/.test(c) ? "fraction" : undefined; break;
        case "fraction": next = /[0-9]/.test(c) ? "fraction" : /[eE]/.test(c) ? "exponent" : undefined; break;
        case "exponent": next = /[+-]/.test(c) ? "sign" : /[0-9]/.test(c) ? "digits" : undefined; break;
        case "sign": next = /[0-9]/.test(c) ? "digits" : undefined; break;
        case "digits": next = /[0-9]/.test(c) ? "digits" : undefined; break;
      }
      if (next) {
        number = next;
        i++;
        continue;
      }
      if (!["zero", "integer", "fraction", "digits"].includes(number)) return false;
      mode = "syntax";
      continue;
    }

    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    const state = stack[stack.length - 1];
    if (state === "done") return false;
    if (state === "key-or-end" && c === "}") {
      stack.pop();
      i++;
      continue;
    }
    if (state === "key-or-end" || state === "key") {
      if (c !== '"') return false;
      key = true;
      mode = "string";
      i++;
      continue;
    }
    if (state === "colon") {
      if (c !== ":") return false;
      stack[stack.length - 1] = "object-value";
      i++;
      continue;
    }
    if (state === "object-separator" || state === "array-separator") {
      if (c === (state === "object-separator" ? "}" : "]")) {
        stack.pop();
      } else if (c === ",") {
        stack[stack.length - 1] = state === "object-separator" ? "key" : "array-value";
      } else {
        return false;
      }
      i++;
      continue;
    }
    if (state === "array-value-or-end" && c === "]") {
      stack.pop();
      i++;
      continue;
    }
    stack[stack.length - 1] = state === "value" ? "done"
      : state === "object-value" ? "object-separator" : "array-separator";
    i++;
    if (c === "{") stack.push("key-or-end");
    else if (c === "[") stack.push("array-value-or-end");
    else if (c === '"') { key = false; mode = "string"; }
    else if (c === "t" || c === "f" || c === "n") {
      literal = c === "t" ? "true" : c === "f" ? "false" : "null";
      literalAt = 1;
      mode = "literal";
    } else if (c === "-" || /[0-9]/.test(c)) {
      number = c === "-" ? "minus" : c === "0" ? "zero" : "integer";
      mode = "number";
    } else {
      return false;
    }
  }

  if (mode === "number") {
    if (!["zero", "integer", "fraction", "digits"].includes(number)) return true;
    mode = "syntax";
  }
  return mode !== "syntax" || stack.length !== 1 || stack[0] !== "done";
}
