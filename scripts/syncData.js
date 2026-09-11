// Copies the ETL output (data/bookings.json) into public/data so Vite can
// serve it as a static asset the app fetches at runtime. Runs automatically
// before `dev` and `build` (see package.json) so the dashboard always
// reflects the latest `node etl.js` run.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(rootDir, 'data', 'bookings.json');
const destDir = join(rootDir, 'public', 'data');
const dest = join(destDir, 'bookings.json');

if (!existsSync(source)) {
  console.error(`sync-data: ${source} not found. Run "node etl.cjs" first.`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
console.log(`sync-data: copied ${source} -> ${dest}`);
