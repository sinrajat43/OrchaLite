import jsonata = require('jsonata');

/**
 * A param value with its {{ ... }} expressions compiled. Objects and arrays
 * are walked, so an expression can sit at any depth.
 */
export type Template =
  | { kind: 'literal'; value: unknown }
  | { kind: 'expression'; source: string; expr: jsonata.Expression }
  | { kind: 'interpolation'; parts: Array<string | { source: string; expr: jsonata.Expression }> }
  | { kind: 'object'; entries: Array<[string, Template]> }
  | { kind: 'array'; items: Template[] };

/** One compiled expression and where it sits */
export interface LocatedExpression {
  /** For messages, e.g. "params.query.q" */
  path: string;
  /** JSON Pointer relative to the compiled value, e.g. "/query/q" */
  pointer: string;
  source: string;
  expr: jsonata.Expression;
}

export interface CompiledTemplate {
  template: Template;
  expressions: LocatedExpression[];
  issues: string[];
}

/**
 * Error thrown when an expression fails while a step's params are resolved
 */
export class ExpressionError extends Error {
  constructor(public readonly path: string, public readonly source: string, message: string) {
    super(`${path}: expression "${source}" failed: ${message}`);
    this.name = 'ExpressionError';
  }
}

const describeError = (error: any): string => error?.message ?? String(error);

/**
 * Splits a string into literal text and {{ ... }} expressions. JSONata itself
 * uses braces, so a closing "}}" only ends an expression once the text before
 * it parses.
 */
function splitString(text: string, path: string, pointer: string, issues: string[]) {
  const parts: Array<string | LocatedExpression> = [];
  let index = 0;

  while (index < text.length) {
    const open = text.indexOf('{{', index);
    if (open < 0) break;
    if (open > index) parts.push(text.slice(index, open));

    let close = text.indexOf('}}', open + 2);
    let lastError: unknown = new Error('missing closing "}}"');
    let found: LocatedExpression | undefined;
    while (close >= 0 && !found) {
      const source = text.slice(open + 2, close).trim();
      try {
        if (!source) throw new Error('empty expression');
        found = { path, pointer, source, expr: jsonata(source) };
      } catch (error) {
        lastError = error;
        close = text.indexOf('}}', close + 1);
      }
    }

    if (!found) {
      issues.push(`${path}: invalid expression "${text.slice(open)}": ${describeError(lastError)}`);
      return undefined;
    }
    parts.push(found);
    index = close + 2;
  }

  if (index < text.length) parts.push(text.slice(index));
  return parts;
}

/**
 * Compiles every {{ ... }} in a value. A string that is a single expression
 * resolves to the expression's value, of any type; a string that mixes text and
 * expressions resolves to a string.
 */
export function compileTemplate(value: unknown, path: string): CompiledTemplate {
  const expressions: LocatedExpression[] = [];
  const issues: string[] = [];

  const compile = (node: unknown, at: string, pointer: string): Template => {
    if (typeof node === 'string') {
      const parts = splitString(node, at, pointer, issues);
      if (!parts || parts.every(part => typeof part === 'string')) return { kind: 'literal', value: node };

      const located = parts.filter((part): part is LocatedExpression => typeof part !== 'string');
      expressions.push(...located);
      const text = parts.filter(part => typeof part === 'string').join('');
      if (located.length === 1 && text.trim() === '') {
        return { kind: 'expression', source: located[0].source, expr: located[0].expr };
      }
      return {
        kind: 'interpolation',
        parts: parts.map(part => (typeof part === 'string' ? part : { source: part.source, expr: part.expr })),
      };
    }
    if (Array.isArray(node)) {
      return { kind: 'array', items: node.map((item, i) => compile(item, `${at}[${i}]`, `${pointer}/${i}`)) };
    }
    if (node && typeof node === 'object') {
      return {
        kind: 'object',
        entries: Object.entries(node).map(([key, child]) => [
          key,
          compile(child, `${at}.${key}`, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`),
        ]),
      };
    }
    return { kind: 'literal', value: node };
  };

  return { template: compile(value, path, ''), expressions, issues };
}

/**
 * JSONata marks arrays it builds as "sequences" with extra properties; copy
 * results into plain arrays and objects so tasks only ever see JSON values.
 */
function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) return Array.from(value, toPlain);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toPlain(child)]));
  }
  return value;
}

const interpolate = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
};

/**
 * Evaluates a compiled template against a scope such as { input, steps }
 * @throws ExpressionError if an expression fails
 */
export async function resolveTemplate(template: Template, scope: unknown, path: string): Promise<unknown> {
  const evaluate = async (source: string, expr: jsonata.Expression, at: string) => {
    try {
      return toPlain(await expr.evaluate(scope));
    } catch (error) {
      throw new ExpressionError(at, source, describeError(error));
    }
  };

  switch (template.kind) {
    case 'literal':
      return template.value;
    case 'expression':
      return evaluate(template.source, template.expr, path);
    case 'interpolation': {
      const parts = await Promise.all(
        template.parts.map(part =>
          typeof part === 'string' ? part : evaluate(part.source, part.expr, path).then(interpolate)
        )
      );
      return parts.join('');
    }
    case 'array':
      return Promise.all(template.items.map((item, i) => resolveTemplate(item, scope, `${path}[${i}]`)));
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const [key, child] of template.entries) {
        const value = await resolveTemplate(child, scope, `${path}.${key}`);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
  }
}

export interface References {
  /** Step ids read through steps.<id> */
  steps: Set<string>;
  /** Input names read through input.<name> */
  inputs: Set<string>;
  issues: string[];
}

// AST keys whose expressions are evaluated against something other than the root scope
const RELATIVE_KEYS = new Set(['stages', 'predicate', 'group', 'terms', 'body']);

/**
 * Finds what an expression reads from the root scope. A path counts as
 * reading the root when it is not nested inside another path (or starts with
 * $$). Paths inside filters and lambdas are relative to an item, so they are
 * not checked.
 * @param rootNames - names allowed at the root besides input and steps
 */
export function findReferences(expr: jsonata.Expression, path: string, rootNames: string[] = []): References {
  const refs: References = { steps: new Set(), inputs: new Set(), issues: [] };
  const allowed = ['input', 'steps', ...rootNames];

  const checkRoot = (steps: any[]) => {
    const [first, second] = steps;
    if (!first) return;
    if (first.type !== 'name') {
      refs.issues.push(`${path}: expressions must start from ${allowed.join(', ')}`);
      return;
    }
    if (first.value === 'steps') {
      if (first.stages || !second || second.type !== 'name') {
        refs.issues.push(`${path}: reference a step by its id, as in steps.<id>.output`);
      } else {
        refs.steps.add(second.value);
      }
    } else if (first.value === 'input') {
      if (second?.type === 'name') refs.inputs.add(second.value);
    } else if (!allowed.includes(first.value)) {
      refs.issues.push(`${path}: unknown name "${first.value}"; expressions start from ${allowed.join(', ')}`);
    }
  };

  const walk = (node: any, atRoot: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach(child => walk(child, atRoot));
      return;
    }
    if (!node || typeof node !== 'object') return;

    if (node.type === 'path') {
      const [first, ...rest] = node.steps;
      if (first?.type === 'variable' && first.value === '$') checkRoot(rest); // $$.x
      else if (first?.type === 'variable' && first.value === '') { if (atRoot) checkRoot(rest); } // $.x
      else if (atRoot) checkRoot(node.steps);
      node.steps.forEach((step: any, i: number) => walk(step, i === 0 ? atRoot : false));
      for (const key of RELATIVE_KEYS) if (node[key]) walk(node[key], false);
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      if (child && typeof child === 'object') walk(child, RELATIVE_KEYS.has(key) ? false : atRoot);
    }
  };

  walk(expr.ast(), true);
  return refs;
}
