// Fails if the source uses patterns the Security section rules out.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const banned = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\b/, 'new Function'],
  [/\.innerHTML\b/, 'innerHTML'],
  [/\.outerHTML\b/, 'outerHTML'],
  [/insertAdjacentHTML/, 'insertAdjacentHTML'],
  [/document\.write\b/, 'document.write'],
  [/importScripts\s*\(/, 'importScripts'],
  [/createContextualFragment/, 'createContextualFragment'],
  [/<script[\s>]/i, 'inline <script>'],
  [/\bsetTimeout\s*\(\s*['"`]/, 'setTimeout with a string'],
  [/\bsetInterval\s*\(\s*['"`]/, 'setInterval with a string'],
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|html)$/.test(name)) yield full;
  }
}

let problems = 0;
for (const dir of ['src', 'static']) {
  for (const file of files(join(root, dir))) {
    const text = readFileSync(file, 'utf8');
    for (const [re, label] of banned) {
      if (file.endsWith('.html') && label === 'inline <script>') {
        // Only external scripts (src=...) are allowed in the popup page.
        if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(text)) {
          console.error(`${relative(root, file)}: inline <script>`);
          problems += 1;
        }
        continue;
      }
      if (re.test(text)) {
        console.error(`${relative(root, file)}: uses ${label}`);
        problems += 1;
      }
    }
  }
}
if (problems > 0) process.exit(1);
console.log('Audit passed: no eval, no HTML string injection, no inline scripts.');
