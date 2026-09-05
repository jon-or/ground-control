import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(homedir(), '.claude', 'projects');
const id = 'a1b2c3d4-0000-4000-8000-000000000000';
const safe = (value) => {
  if (typeof value === 'string') return '[redacted]';
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, safe(child)]));
  return value;
};
// Whole records from one prompted parent transcript; string values outside the metadata under test are redacted.
for (const dir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const file of readdirSync(join(root, dir.name)).filter((f) => /^[a-f\d-]{36}\.jsonl$/i.test(f))) {
    const records = readFileSync(join(root, dir.name, file), 'utf8').split('\n').flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter((r) => r.sessionId === file.slice(0, -6) && !r.isSidechain);
    const prompt = records.find((r) => r.type === 'user' && r.cwd && r.gitBranch);
    const title = records.find((r) => r.type === 'custom-title' || r.type === 'ai-title');
    if (!prompt || !title) continue;
    const scrubbed = [prompt, title].map((r) => ({ ...safe(r), type: r.type, sessionId: id,
      ...(r.cwd ? { cwd: '/work/42-example' } : {}), ...(r.gitBranch ? { gitBranch: '42-example' } : {}),
      ...(r.customTitle ? { customTitle: 'Recorded custom title' } : {}), ...(r.aiTitle ? { aiTitle: 'Recorded automatic title' } : {}),
    }));
    writeFileSync(new URL('./history-records.json', import.meta.url), JSON.stringify(scrubbed, null, 2) + '\n');
    process.exit(0);
  }
}
throw new Error('No prompted parent transcript with a title was found.');
