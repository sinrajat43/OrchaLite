import { readFileSync } from 'fs';
import { join } from 'path';

export interface Example {
  label: string;
  input: Record<string, unknown>;
  workflow: { name: string; [key: string]: unknown };
}

/** The example workflows the web UI offers, from public/examples.json */
export function loadExample(name: string): Example {
  const examples: Example[] = JSON.parse(readFileSync(join(__dirname, '..', '..', 'public', 'examples.json'), 'utf8'));
  const example = examples.find(e => e.workflow.name === name);
  if (!example) throw new Error(`No example workflow named "${name}"`);
  return structuredClone(example);
}
