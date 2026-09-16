import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const messages = JSON.parse(fs.readFileSync(path.join(root, 'src/i18n/en.json'), 'utf8'));
const failures = [];
let checked = 0;
function visitDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'i18n') visitDirectory(filename); continue; }
    if (!/\.tsx?$/.test(filename)) continue;
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          const key = arg.text;
          if (/\p{Script=Han}/u.test(key)) {
            checked++;
            const translated = messages[key] ?? messages[key.trim()] ?? messages[key.trim().replace(/\s+/g, ' ')];
            const location = `${path.relative(root, filename)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`;
            if (!translated || /\p{Script=Han}/u.test(translated)) failures.push(`${location}: missing English translation for ${JSON.stringify(key)}`);
            else if (JSON.stringify([...key.matchAll(/\{\d+\}/g)].map(m => m[0]).sort()) !== JSON.stringify([...translated.matchAll(/\{\d+\}/g)].map(m => m[0]).sort())) failures.push(`${location}: translation placeholders differ`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
visitDirectory(path.join(root, 'src'));
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`English coverage: ${checked} interface messages checked.`);
