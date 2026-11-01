#!/usr/bin/env node
// Stores the example workflows through the API, so they can be opened and run
// by name. Saving an unchanged workflow creates no new version, so this can be
// rerun. Some examples are invalid on purpose, to show the errors; those are
// skipped.
//
// Usage: ORCHALITE_DEMO_PASSWORD=... node scripts/seed-demo.js http://127.0.0.1:3001

const { readFileSync } = require('fs');
const { join } = require('path');

async function seed(baseUrl) {
  const examples = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'examples.json'), 'utf8'));
  const credentials = Buffer.from(`demo:${process.env.ORCHALITE_DEMO_PASSWORD ?? ''}`).toString('base64');

  for (const { workflow } of examples) {
    const response = await fetch(`${baseUrl}/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${credentials}` },
      body: JSON.stringify(workflow),
    });
    if (response.status === 400) {
      console.log(`Skipped ${workflow.name}: not a valid definition`);
    } else if (!response.ok) {
      throw new Error(`Storing ${workflow.name} returned HTTP ${response.status}`);
    } else {
      const { version, created } = await response.json();
      console.log(`${created ? 'Stored' : 'Unchanged'} ${workflow.name} v${version}`);
    }
  }
}

seed(process.argv[2] ?? 'http://127.0.0.1:3000').catch(error => {
  console.error(`Seeding failed: ${error.message}`);
  process.exit(1);
});
