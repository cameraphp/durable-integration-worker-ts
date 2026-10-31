// Static safety, documentation and traceability checks (validation IDs SC-03, SC-05..SC-08, DOC-01..DOC-03).
// Reads project files only. Exits non-zero on any failure.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const failures = [];
const passes = [];
const check = (id, ok, detail) => (ok ? passes : failures).push(`${id} ${ok ? 'PASS' : 'FAIL'}${detail ? ` - ${detail}` : ''}`);

function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(rel, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(rel);
  }
  return out;
}

// SC-03: no outbound network APIs in application source; loopback-only bind.
const forbiddenNet = [
  /\bfetch\s*\(/, /\bhttps?\.(request|get)\s*\(/, /from\s+['"](node:)?https?['"]/, /from\s+['"](node:)?net['"]/,
  /from\s+['"](node:)?dgram['"]/, /\bundici\b/, /\baxios\b/, /0\.0\.0\.0/,
];
const srcFiles = walk('src', ['.ts']);
const netHits = srcFiles.flatMap((f) => forbiddenNet.filter((rx) => rx.test(read(f))).map((rx) => `${f}: ${rx}`));
check('SC-03', netHits.length === 0 && /HOST = '127\.0\.0\.1'/.test(read('src/config.ts')) && /host: rt\.config\.host/.test(read('src/cli/api.ts')), netHits.join('; '));

// SC-05: exact dependency versions.
const pkg = JSON.parse(read('package.json'));
const loose = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(v));
check('SC-05', loose.length === 0 && existsSync(join(root, 'package-lock.json')), loose.map(([k, v]) => `${k}@${v}`).join(', '));

// SC-06: .gitignore coverage.
const gitignore = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
const requiredIgnores = ['.runtime/', '.env', '*.log', 'coverage/', 'dist/', 'node_modules/'];
const missingIgnores = requiredIgnores.filter((r) => !gitignore.includes(r));
check('SC-06', missingIgnores.length === 0, missingIgnores.join(', '));

// SC-07: no real .env; .env.example holds only allow-listed non-secret settings.
const allowedEnv = new Set(['PORT', 'RUNTIME_DIR', 'MAX_ATTEMPTS', 'JOB_TIMEOUT_MS', 'BASE_BACKOFF_MS', 'MAX_BACKOFF_MS', 'STALE_LOCK_MS', 'LOCK_ACQUIRE_TIMEOUT_MS', 'WORKER_BATCH_SIZE', 'LOG_LEVEL', 'MOCK_SCENARIOS_ENABLED']);
const envKeys = read('.env.example').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => l.split('=')[0].trim());
const badEnv = envKeys.filter((k) => !allowedEnv.has(k));
check('SC-07', !existsSync(join(root, '.env')) && badEnv.length === 0, badEnv.join(', ') || (existsSync(join(root, '.env')) ? '.env exists' : ''));

// SC-08: every T-* validation ID appears as a test title; every requirement ID is mapped.
const validation = read('specs/2026-10-31-durable-integration-worker/validation.md');
const requirements = read('specs/2026-10-31-durable-integration-worker/requirements.md');
const testIds = [...new Set(validation.match(/\bT-[A-Z]+-\d+\b/g) ?? [])];
const testText = walk('tests', ['.ts']).map(read).join('\n');
const missingTests = testIds.filter((id) => !new RegExp(`it\\(\\s*['"\`]${id}\\b`).test(testText));
const reqIds = [...new Set(requirements.match(/\b(FR|NFR|SAFE)-\d{3}\b/g) ?? [])];
const mappingSection = validation.split('## 2. Requirement')[1] ?? '';
const unmapped = reqIds.filter((id) => !new RegExp(`^\\|\\s*${id}\\s*\\|`, 'm').test(mappingSection));
check('SC-08', testIds.length > 0 && missingTests.length === 0 && unmapped.length === 0,
  [`${testIds.length} test IDs, ${reqIds.length} requirement IDs`, missingTests.length ? `missing tests: ${missingTests}` : '', unmapped.length ? `unmapped: ${unmapped}` : ''].filter(Boolean).join('; '));

// DOC-01: README structure.
const readme = read('README.md');
const doc01 = [/^##\s+.*Limits/im, /```mermaid/, /^##\s+Demo walkthrough/im, /docs\/demo-walkthrough\.md/, /^##\s+.*journal guarantees/im].filter((rx) => !rx.test(readme));
check('DOC-01', doc01.length === 0, doc01.map(String).join(', '));

// DOC-02: forbidden claims only in negated context.
const claimFiles = ['README.md', ...walk('docs', ['.md']), ...(existsSync(join(root, 'BUILD_REPORT.md')) ? ['BUILD_REPORT.md'] : [])];
const claims = /(production[- ]ready|exactly[- ]once|zero data loss|zero lost|hipaa[- ]compliant|certified|guaranteed delivery)/i;
const negation = /\b(not|no|never|without|nor|isn't|doesn't|does not|is not|non-goals?)\b/i;
const claimHits = [];
for (const f of claimFiles) {
  read(f).split(/\r?\n/).forEach((line, i) => {
    if (claims.test(line) && !negation.test(line)) claimHits.push(`${relative(root, join(root, f))}:${i + 1}`);
  });
}
if (claims.test(pkg.description) && !negation.test(pkg.description)) claimHits.push('package.json:description');
check('DOC-02', claimHits.length === 0, claimHits.join(', '));

// DOC-03: supporting docs exist; correlation-ID flow documented.
const docs = ['docs/architecture.md', 'docs/demo-walkthrough.md', 'docs/limitations.md'];
const missingDocs = docs.filter((d) => !existsSync(join(root, d)));
check('DOC-03', missingDocs.length === 0 && /^##\s+Correlation-ID flow/im.test(read('docs/architecture.md')), missingDocs.join(', '));

for (const line of [...passes, ...failures]) console.log(line);
if (failures.length) {
  console.error(`safety-check: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`safety-check: all ${passes.length} checks passed`);
