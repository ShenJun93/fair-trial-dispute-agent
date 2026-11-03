import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markdown = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) markdown.push(full);
  }
}
await collect(path.join(root, 'docs'));
await collect(path.join(root, 'submission'));
markdown.push(path.join(root, 'README.md'));

const failures = [];
for (const file of markdown) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let target = match[1].replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|data:|codex:)/i.test(target)) continue;
    target = decodeURIComponent(target);
    const hashIndex = target.indexOf('#');
    const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : '';
    const targetPath = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const resolved = path.resolve(path.dirname(file), targetPath || '.');
    try { await stat(resolved); }
    catch (error) { failures.push(`${path.relative(root,file)} -> ${target} (${error.code}; ${path.relative(root,resolved)})`); continue; }
    if (fragment && resolved.toLowerCase().endsWith('.md')) {
      const content = await readFile(resolved, 'utf8');
      const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) => heading[1]
        .replace(/`([^`]+)`/g, '$1').replace(/<[^>]+>/g, '').replace(/[\p{P}\p{S}]/gu, '')
        .trim().toLowerCase().replace(/\s+/g, '-'));
      if (!headings.includes(fragment.toLowerCase())) failures.push(`${path.relative(root,file)} -> ${target} (heading anchor not found)`);
    }
  }
}
if (failures.length) {
  console.error(`MARKDOWN_LINKS_FAIL ${failures.length}`);
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log(`MARKDOWN_LINKS_PASS ${markdown.length} files`);
