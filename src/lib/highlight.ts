/**
 * AgentGrade Studio — dependency-free syntax highlighting.
 *
 * A tokenizer rather than a parser: it produces a flat token stream good enough
 * to colour a code drawer, with no CDN, no WASM grammar download, and no
 * hydration mismatch. It is deliberately conservative — anything it cannot
 * classify stays `plain`.
 *
 * The one invariant that matters, and that the tests enforce: concatenating
 * every token's text reproduces the input exactly. A highlighter that silently
 * drops a character would corrupt code a developer is about to copy.
 */

import type { CodeLanguage } from './codegen.js';

/** Classes a token can carry. */
export type TokenType =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'literal'
  | 'punctuation'
  | 'tag'
  | 'attribute'
  | 'property';

/** One classified run of source text. */
export interface Token {
  type: TokenType;
  value: string;
}

const JS_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'of', 'return', 'static',
  'switch', 'this', 'throw', 'try', 'type', 'typeof', 'var', 'void', 'while', 'yield', 'as',
  'satisfies', 'readonly', 'declare', 'namespace', 'public', 'private', 'protected',
]);

const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

const PUNCTUATION = new Set([...'{}()[];:,.<>=+-*/%!?&|^~']);

/**
 * Tokenizes `source` for the given language.
 * Never throws; unknown languages fall back to a single plain token.
 */
export function highlight(source: string, language: CodeLanguage): Token[] {
  try {
    switch (language) {
      case 'javascript':
      case 'tsx':
        return tokenizeScript(source);
      case 'json':
        return tokenizeJson(source);
      case 'html':
        return tokenizeHtml(source);
      default:
        return [{ type: 'plain', value: source }];
    }
  } catch {
    return [{ type: 'plain', value: source }];
  }
}

/** Splits a token stream into lines, so a renderer can number them. */
export function highlightLines(source: string, language: CodeLanguage): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of highlight(source, language)) {
    const parts = token.value.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part.length > 0) lines[lines.length - 1].push({ type: token.type, value: part });
    });
  }
  return lines;
}

/* -------------------------------------------------------------------------- */
/* JavaScript / TypeScript                                                     */
/* -------------------------------------------------------------------------- */

function tokenizeScript(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let pending = '';

  const flush = (): void => {
    if (pending.length > 0) {
      tokens.push({ type: 'plain', value: pending });
      pending = '';
    }
  };
  const push = (type: TokenType, value: string): void => {
    flush();
    tokens.push({ type, value });
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    // Line comment
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      push('comment', source.slice(index, stop));
      index = stop;
      continue;
    }

    // Block comment
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      push('comment', source.slice(index, stop));
      index = stop;
      continue;
    }

    // String or template literal
    if (character === '"' || character === "'" || character === '`') {
      const stop = findStringEnd(source, index, character);
      push('string', source.slice(index, stop));
      index = stop;
      continue;
    }

    // Number
    if (/[0-9]/.test(character) && !/[A-Za-z0-9_$]/.test(source[index - 1] ?? '')) {
      let stop = index;
      while (stop < source.length && /[0-9._eE+-]/.test(source[stop])) {
        // `+`/`-` only continue a number as an exponent sign.
        if ((source[stop] === '+' || source[stop] === '-') && !/[eE]/.test(source[stop - 1] ?? '')) break;
        stop++;
      }
      push('number', source.slice(index, stop));
      index = stop;
      continue;
    }

    // Identifier / keyword
    if (/[A-Za-z_$]/.test(character)) {
      let stop = index;
      while (stop < source.length && /[A-Za-z0-9_$]/.test(source[stop])) stop++;
      const word = source.slice(index, stop);
      if (JS_KEYWORDS.has(word)) push('keyword', word);
      else if (JS_LITERALS.has(word)) push('literal', word);
      else if (source[stop] === ':') push('property', word);
      else pending += word;
      index = stop;
      continue;
    }

    if (PUNCTUATION.has(character)) {
      push('punctuation', character);
      index++;
      continue;
    }

    pending += character;
    index++;
  }

  flush();
  return tokens;
}

/** Finds the index just past a string that starts at `start`. */
function findStringEnd(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    // An unterminated single-quoted string ends at the newline, so one broken
    // line cannot swallow the rest of the file.
    if (character === '\n' && quote !== '`') return index;
    index++;
  }
  return source.length;
}

/* -------------------------------------------------------------------------- */
/* JSON                                                                        */
/* -------------------------------------------------------------------------- */

function tokenizeJson(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let pending = '';

  const flush = (): void => {
    if (pending.length > 0) {
      tokens.push({ type: 'plain', value: pending });
      pending = '';
    }
  };
  const push = (type: TokenType, value: string): void => {
    flush();
    tokens.push({ type, value });
  };

  while (index < source.length) {
    const character = source[index];

    if (character === '"') {
      const stop = findStringEnd(source, index, '"');
      // A string immediately followed by `:` is a key, not a value.
      let lookahead = stop;
      while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead++;
      push(source[lookahead] === ':' ? 'property' : 'string', source.slice(index, stop));
      index = stop;
      continue;
    }

    if (/[0-9-]/.test(character)) {
      let stop = index;
      while (stop < source.length && /[0-9.eE+-]/.test(source[stop])) stop++;
      push('number', source.slice(index, stop));
      index = stop;
      continue;
    }

    if (/[a-z]/.test(character)) {
      let stop = index;
      while (stop < source.length && /[a-z]/.test(source[stop])) stop++;
      const word = source.slice(index, stop);
      if (JS_LITERALS.has(word)) push('literal', word);
      else pending += word;
      index = stop;
      continue;
    }

    if (PUNCTUATION.has(character)) {
      push('punctuation', character);
      index++;
      continue;
    }

    pending += character;
    index++;
  }

  flush();
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* HTML                                                                        */
/* -------------------------------------------------------------------------- */

function tokenizeHtml(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let pending = '';

  const flush = (): void => {
    if (pending.length > 0) {
      tokens.push({ type: 'plain', value: pending });
      pending = '';
    }
  };
  const push = (type: TokenType, value: string): void => {
    flush();
    tokens.push({ type, value });
  };

  while (index < source.length) {
    // Comment
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      const stop = end === -1 ? source.length : end + 3;
      push('comment', source.slice(index, stop));
      index = stop;
      continue;
    }

    // Tag
    if (source[index] === '<') {
      const end = findTagEnd(source, index);
      tokenizeTag(source.slice(index, end)).forEach((token) => push(token.type, token.value));
      index = end;
      continue;
    }

    pending += source[index];
    index++;
  }

  flush();
  return tokens;
}

/** Finds the index just past a tag, respecting quoted attribute values. */
function findTagEnd(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'") {
      index = findStringEnd(source, index, character);
      continue;
    }
    if (character === '>') return index + 1;
    index++;
  }
  return source.length;
}

/** Classifies the inside of a single tag. */
function tokenizeTag(tag: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const nameMatch = /^<\/?[A-Za-z][\w-]*/.exec(tag);
  if (nameMatch) {
    tokens.push({ type: 'tag', value: nameMatch[0] });
    index = nameMatch[0].length;
  }

  while (index < tag.length) {
    const character = tag[index];

    if (/\s/.test(character)) {
      let stop = index;
      while (stop < tag.length && /\s/.test(tag[stop])) stop++;
      tokens.push({ type: 'plain', value: tag.slice(index, stop) });
      index = stop;
      continue;
    }

    if (character === '"' || character === "'") {
      const stop = findStringEnd(tag, index, character);
      tokens.push({ type: 'string', value: tag.slice(index, stop) });
      index = stop;
      continue;
    }

    if (/[A-Za-z_:]/.test(character)) {
      let stop = index;
      while (stop < tag.length && /[\w:.-]/.test(tag[stop])) stop++;
      tokens.push({ type: 'attribute', value: tag.slice(index, stop) });
      index = stop;
      continue;
    }

    tokens.push({ type: 'punctuation', value: character });
    index++;
  }

  return tokens;
}
