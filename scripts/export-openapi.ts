import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildOpenApiSpec } from '../packages/api/src/openapi.js';

/** Dump the OpenAPI spec to deliverables/openapi.json (no server/DB needed). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, '..', 'deliverables', 'openapi.json');
writeFileSync(out, JSON.stringify(buildOpenApiSpec(), null, 2));
console.log(`Wrote ${out}`);
