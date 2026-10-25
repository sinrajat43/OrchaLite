import { compileTemplate, ExpressionError, findReferences, resolveTemplate } from './template';

const scope = {
  input: { org: 'nestjs', minStars: 100 },
  steps: { fetch: { output: { items: [{ name: 'a', stars: 50 }, { name: 'b', stars: 500 }] } } },
};

const resolve = async (value: unknown) => {
  const { template, issues } = compileTemplate(value, 'params');
  expect(issues).toEqual([]);
  return resolveTemplate(template, scope, 'params');
};

const referencesOf = (source: string, rootNames?: string[]) => {
  const { expressions, issues } = compileTemplate(`{{ ${source} }}`, 'params.x');
  expect(issues).toEqual([]);
  return findReferences(expressions[0].expr, 'params.x', rootNames);
};

describe('compileTemplate and resolveTemplate', () => {
  it('leaves values without expressions alone', async () => {
    expect(await resolve({ a: 1, b: [true, null, 'text'], c: 'no {braces}' })).toEqual({
      a: 1,
      b: [true, null, 'text'],
      c: 'no {braces}',
    });
  });

  it('resolves a whole-string expression to a value of any type', async () => {
    expect(await resolve('{{ steps.fetch.output.items }}')).toEqual(scope.steps.fetch.output.items);
    expect(await resolve('  {{ input.minStars }} ')).toBe(100);
  });

  it('interpolates expressions inside text as strings', async () => {
    expect(await resolve('org:{{ input.org }} stars:>{{ input.minStars }}')).toBe('org:nestjs stars:>100');
    expect(await resolve('{{ input.org }}/{{ input.missing }}')).toBe('nestjs/');
  });

  it('resolves expressions nested in objects and arrays, dropping undefined keys', async () => {
    expect(await resolve({ q: { org: '{{ input.org }}' }, list: ['{{ input.minStars }}'], gone: '{{ input.nope }}' })).toEqual({
      q: { org: 'nestjs' },
      list: [100],
    });
  });

  it('accepts JSONata that itself contains "}}"', async () => {
    expect(await resolve('{{ {"a": {"b": input.org}} }}')).toEqual({ a: { b: 'nestjs' } });
  });

  it('can filter and reshape, reaching the root with $$ inside a filter', async () => {
    expect(await resolve('{{ steps.fetch.output.items[stars >= $$.input.minStars].name[] }}')).toEqual(['b']);
  });

  it('reports a syntax error with its location', () => {
    const { issues } = compileTemplate({ q: '{{ steps.( }}' }, 'params');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^params\.q: invalid expression/);
    expect(compileTemplate('{{ input.org', 'params').issues[0]).toContain('missing closing "}}"');
    expect(compileTemplate('{{ }}', 'params').issues[0]).toContain('empty expression');
  });

  it('wraps evaluation errors with the location and source', async () => {
    const { template } = compileTemplate({ x: '{{ $notAFunction() }}' }, 'params');
    const error = await resolveTemplate(template, scope, 'params').catch((e: Error) => e) as Error;
    expect(error).toBeInstanceOf(ExpressionError);
    expect(error.message).toMatch(/^params\.x: expression "\$notAFunction\(\)" failed:/);
  });
});

describe('findReferences', () => {
  it('collects steps and inputs read from the root', () => {
    const refs = referencesOf('$count(steps.a.output) > 0 ? steps.b.output : {"x": input.org, "y": $$.input.n}');
    expect([...refs.steps]).toEqual(['a', 'b']);
    expect([...refs.inputs].sort()).toEqual(['n', 'org']);
    expect(refs.issues).toEqual([]);
  });

  it('does not treat names inside filters or later path steps as root names', () => {
    const refs = referencesOf('steps.a.output.items[input > 1 and steps = 2].steps');
    expect([...refs.steps]).toEqual(['a']);
    expect(refs.inputs.size).toBe(0);
    expect(refs.issues).toEqual([]);
  });

  it('rejects step references it cannot check', () => {
    expect(referencesOf('steps.*.output').issues[0]).toContain('reference a step by its id');
    expect(referencesOf('steps["a"]').issues[0]).toContain('reference a step by its id');
    expect(referencesOf('steps').issues[0]).toContain('reference a step by its id');
  });

  it('rejects unknown root names, unless allowed', () => {
    expect(referencesOf('stepz.a.output').issues[0]).toBe(
      'params.x: unknown name "stepz"; expressions start from input, steps'
    );
    expect(referencesOf('item.url', ['item']).issues).toEqual([]);
  });
});
