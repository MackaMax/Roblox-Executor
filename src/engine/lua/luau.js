/**
 * Luau → Lua 5.3 syntax shim.
 *
 * Roblox scripts are written in Luau. Fengari implements Lua 5.3, so before
 * compiling we translate the few Luau-only constructs:
 *
 *   x += 1                    compound assignment
 *   `hello {name}!`           string interpolation
 *   continue                  loop continuation  (→ wrapped body)
 *   local x: number = 1       optional type annotations
 *
 * Implementation notes
 * --------------------
 * The source is tokenised so strings and comments are never rewritten. Two
 * passes run over the token stream:
 *
 *  1. compound assignment + interpolation + type annotations (local rewrites)
 *  2. `continue`, which needs structural knowledge of the enclosing loop and is
 *     therefore handled by wrapLoopsWithContinue(): the body of any loop that
 *     contains `continue` is rewritten as
 *
 *        while cond do  -->  while cond do repeat
 *                              <body with continue → break>
 *                            until true end
 *
 *     `break` inside `repeat … until true` leaves only that inner loop, which is
 *     exactly the semantics of Luau's `continue`.
 */

const COMPOUND = ['..=', '+=', '-=', '*=', '/=', '%=', '^='];

/**
 * @param {string} source Luau source
 * @returns {string} Lua 5.3 source
 */
export function luauToLua(source) {
  const tokens = tokenize(source);
  const rewritten = rewriteLocals(tokens);
  let code = rewritten.map((t) => t.text).join('');
  code = stripTypeAnnotations(code);
  code = wrapLoopsWithContinue(code);
  return code;
}

/**
 * Statement-level `continue` support.
 *
 * Lua 5.3 has `goto`, but a `goto` needs a visible label. Luau's `continue`
 * means "jump to the end of the loop body", so we wrap loop bodies that contain
 * it in `repeat … until true` and turn `continue` into `break` for that inner
 * loop. That is the standard, label-free translation and behaves identically.
 */
export function translateContinue(body) {
  return body.replace(/(^|[^A-Za-z0-9_.])continue(?!\w)/g, '$1break');
}

/** Hoisted loop scanner used by wrapLoopsWithContinue (see below). */

/* ====================================================================== */
/* 1. tokenizer                                                           */
/* ====================================================================== */

/**
 * @param {string} source
 * @returns {Array<{type: string, text: string}>}
 *   types: code | string | longstring | comment | longcomment | interpolated
 */
export function tokenize(source) {
  const tokens = [];
  let code = '';
  let i = 0;
  const n = source.length;

  const flush = () => {
    if (code) {
      tokens.push({ type: 'code', text: code });
      code = '';
    }
  };

  while (i < n) {
    const ch = source[i];

    // long bracket string  [[ ... ]] / [==[ ... ]==]
    if (ch === '[') {
      const m = /^\[(=*)\[/.exec(source.slice(i));
      if (m) {
        flush();
        const close = `]${m[1]}]`;
        const end = source.indexOf(close, i + m[0].length);
        const stop = end === -1 ? n : end + close.length;
        tokens.push({ type: 'longstring', text: source.slice(i, stop) });
        i = stop;
        continue;
      }
    }

    // comments
    if (ch === '-' && source[i + 1] === '-') {
      const m = /^--\[(=*)\[/.exec(source.slice(i));
      if (m) {
        flush();
        const close = `]${m[1]}]`;
        const end = source.indexOf(close, i + m[0].length);
        const stop = end === -1 ? n : end + close.length;
        tokens.push({ type: 'longcomment', text: source.slice(i, stop) });
        i = stop;
        continue;
      }
      flush();
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      tokens.push({ type: 'comment', text: source.slice(i, j) });
      i = j;
      continue;
    }

    // quoted strings
    if (ch === '"' || ch === "'") {
      flush();
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === ch) { j++; break; }
        if (source[j] === '\n') break;
        j++;
      }
      tokens.push({ type: 'string', text: source.slice(i, j) });
      i = j;
      continue;
    }

    // backtick interpolation
    if (ch === '`') {
      flush();
      const { text, next } = readInterpolated(source, i);
      tokens.push({ type: 'interpolated', text });
      i = next;
      continue;
    }

    code += ch;
    i++;
  }
  flush();
  return tokens;
}

function readInterpolated(source, start) {
  let i = start + 1;
  const parts = [];
  let literal = '';
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    if (ch === '\\') { literal += source.slice(i, i + 2); i += 2; continue; }
    if (ch === '`') {
      parts.push(JSON.stringify(literal));
      return {
        text: parts.length === 1 ? parts[0] : `(${parts.join(' .. ')})`,
        next: i + 1,
      };
    }
    if (ch === '{') {
      parts.push(JSON.stringify(literal));
      literal = '';
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}') depth--;
        if (depth === 0) break;
        j++;
      }
      parts.push(`tostring(${source.slice(i + 1, j)})`);
      i = j + 1;
      continue;
    }
    literal += ch;
    i++;
  }
  return { text: JSON.stringify(literal), next: n };
}

/* ====================================================================== */
/* 2. local rewrites                                                      */
/* ====================================================================== */

function rewriteLocals(tokens) {
  const out = [];
  for (const token of tokens) {
    if (token.type !== 'code') {
      out.push(token);
      continue;
    }
    let text = token.text;

    // compound assignment, repeatedly (a line may contain several)
    let guard = 0;
    let changed = true;
    while (changed && guard++ < 500) {
      changed = false;
      for (const op of COMPOUND) {
        const found = findCompoundOp(text, op);
        if (!found) continue;
        const { start, lvalue } = found;
        const baseOp = op.slice(0, -1);
        const opEnd = found.opIndex + op.length;
        const before = text.slice(0, start);
        const after = text.slice(opEnd).replace(/^[ \t]+/, '');
        text = `${before}${lvalue} = ${lvalue} ${baseOp} ${after}`;
        changed = true;
        break;
      }
    }

    out.push({ type: 'code', text });
  }
  return out;
}

/**
 * Locate a compound operator that is being used as an assignment and return
 * its statement-position lvalue.
 */
function findCompoundOp(text, op) {
  let idx = text.indexOf(op);
  while (idx !== -1) {
    const before = text.slice(0, idx);
    const lvalue = trailingLvalue(before);
    if (lvalue) return { start: lvalue.start, lvalue: lvalue.target, opIndex: idx };
    idx = text.indexOf(op, idx + 1);
  }
  return null;
}

/**
 * The lvalue chain ending at the end of `text`.
 *
 * There is no need to verify statement position: `+=` (and friends) are not
 * valid Lua tokens, so any occurrence inside code must be a compound
 * assignment and the thing to its left its target.
 */
function trailingLvalue(text) {
  const m = /((?:[A-Za-z_][\w]*)(?:\s*(?:\.[A-Za-z_][\w]*|\[[^\]\n]*\]))*)[ \t]*$/.exec(text);
  if (!m) return null;
  const target = m[1].trim();
  if (!target) return null;
  return { target, start: m.index };
}

/* ====================================================================== */
/* 3. type annotations                                                    */
/* ====================================================================== */

function stripTypeAnnotations(code) {
  let out = code;
  // casts: `expr :: Type`
  out = out.replace(/[ \t]*::[ \t]*[A-Za-z_][\w.]*(?:[ \t]*<[^<>\n]*>)?/g, '');
  // `local x: Type = …` and `function f(a: Type, b: Type): Type`
  out = out.replace(
    /(\b(?:local|function)\b[^\n=]*?)([A-Za-z_][\w]*)[ \t]*:[ \t]*[A-Za-z_][\w.]*(?:[ \t]*<[^<>\n]*>)?(?=[ \t]*[,)=])/g,
    '$1$2'
  );
  // return-type annotation on function signatures
  out = out.replace(/(function[^\n]*\))[ \t]*:[ \t]*[A-Za-z_][\w.]*/g, '$1');
  return out;
}

/* ====================================================================== */
/* 4. continue                                                            */
/* ====================================================================== */

/**
 * Rewrites `continue` by wrapping loop bodies:
 *
 *   while cond do BODY end     →   while cond do repeat BODY(continue→break) until true end
 *   for … do BODY end          →   for … do repeat BODY(continue→break) until true end
 *   repeat BODY until cond     →   repeat repeat BODY(continue→break) until true until cond
 *
 * Only loops whose body actually contains `continue` are wrapped, so ordinary
 * code is untouched.
 */
export function wrapLoopsWithContinue(code) {
  if (!/\bcontinue\b/.test(code)) return code;

  let result = code;
  let guard = 0;
  for (;;) {
    // Re-scan every round: wrapping changes offsets, and nested loops that
    // contained `continue` must be handled from the inside out.
    const loops = scanLoops(result);
    let wrapped = false;
    for (const loop of loops) {
      const body = result.slice(loop.bodyStart, loop.bodyEnd);
      if (!/(^|[^A-Za-z0-9_.])continue(?!\w)/.test(body)) continue;
      const replacement = ` repeat ${translateContinue(body)} until true `;
      result = result.slice(0, loop.bodyStart) + replacement + result.slice(loop.bodyEnd);
      wrapped = true;
      break;
    }
    if (!wrapped || guard++ > 100) break;
  }
  return result;
}

/**
 * Scan for loop bodies with their character ranges. Handles while/for (ending
 * at `end`) and repeat (ending at `until`). Strings and comments are skipped.
 * Returns outermost-first because they are discovered while scanning.
 */
export function scanLoops(code) {
  // Build a mask of "code" characters (1) vs strings/comments (0) so keywords
  // inside strings or comments are ignored.
  const tokens = tokenize(code);
  const mask = new Uint8Array(code.length);
  let pos = 0;
  for (const token of tokens) {
    const isCode = token.type === 'code';
    if (isCode) mask.fill(1, pos, pos + token.text.length);
    pos += token.text.length;
  }

  const keywordRe = /\b(while|for|repeat|do|then|function|if|elseif|else|end|until)\b/g;
  const loops = [];
  const stack = [];
  let m;

  while ((m = keywordRe.exec(code)) !== null) {
    // skip if the keyword starts inside a string/comment
    if (!mask[m.index]) continue;
    const word = m[1];
    const wordPos = m.index;

    if (word === 'while' || word === 'for') {
      stack.push({ kind: 'loop', bodyStart: null });
    } else if (word === 'repeat') {
      stack.push({ kind: 'repeat', bodyStart: keywordRe.lastIndex });
    } else if (word === 'function') {
      stack.push({ kind: 'block' });
    } else if (word === 'if') {
      // `if … then … end` — the `then` opens the body, `end` closes it
      stack.push({ kind: 'if', bodyStart: null });
    } else if (word === 'do' || word === 'then') {
      const top = stack[stack.length - 1];
      if (top && top.kind === 'loop' && top.bodyStart === null) {
        top.bodyStart = keywordRe.lastIndex;
      } else if (top && top.kind === 'if' && top.bodyStart === null) {
        top.bodyStart = keywordRe.lastIndex;
      } else {
        stack.push({ kind: 'block' });
      }
    } else if (word === 'end') {
      const top = stack.pop();
      if (top && top.kind === 'loop' && top.bodyStart !== null) {
        loops.push({ kind: 'loop', bodyStart: top.bodyStart, bodyEnd: wordPos });
      }
      // `if` and `block` frames simply close here
    } else if (word === 'until') {
      const top = stack.pop();
      if (top && top.kind === 'repeat') {
        loops.push({ kind: 'repeat', bodyStart: top.bodyStart, bodyEnd: wordPos });
      }
    }
  }

  // Innermost loops are pushed last; wrapping them first keeps outer offsets
  // correct as long as we adjust progressively in wrapLoopsWithContinue.
  return loops.reverse();
}

export default luauToLua;
