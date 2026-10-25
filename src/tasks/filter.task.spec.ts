import { contextFor } from '../testing/task-context';
import { FilterTask } from './filter.task';

const repos = [
  { name: 'none', stargazers_count: 0, topics: [] },
  { name: 'some', stargazers_count: 999, topics: ['cli'] },
  { name: 'edge', stargazers_count: 1000, topics: [] },
  { name: 'many', stargazers_count: 50000, topics: ['web', 'cli'] },
];

describe('filter', () => {
  const task = new FilterTask();
  const names = (items: any[]) => items.map(item => item.name);

  it('keeps the items for which the condition holds, reading vars as $name', async () => {
    const kept = await task.execute(contextFor({ items: repos, where: 'stargazers_count >= $min', vars: { min: 1000 } }));
    expect(names(kept)).toEqual(['edge', 'many']);
  });

  it("follows JSONata's truthiness, so an empty array or object is false", async () => {
    expect(names(await task.execute(contextFor({ items: repos, where: 'topics' })))).toEqual(['some', 'many']);
    expect(names(await task.execute(contextFor({ items: repos, where: '"cli" in topics' })))).toEqual(['some', 'many']);
  });

  it('checks the condition at submit time', () => {
    expect(task.validate({ items: '{{ x }}', where: 'stargazers_count >= $min' })).toEqual([]);
    expect(task.validate({ where: 'stargazers_count >=' })[0]).toMatch(/^params\.where: invalid condition/);
  });

  it('rejects {{ }} in the condition, so data cannot rewrite it', () => {
    expect(task.validate({ where: 'name = "{{ input.name }}"' })).toEqual([
      'params.where is evaluated per item; pass values in through vars instead of {{ ... }}',
    ]);
  });
});
