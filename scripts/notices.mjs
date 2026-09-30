// Writes THIRD-PARTY-NOTICES.md with the license of every runtime dependency
// (the libraries bundled into main.js). Run it with `npm run notices` after
// changing dependencies.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { encoding: 'utf8' }));
const packages = new Map();
const walk = (deps = {}) => {
	for (const [name, info] of Object.entries(deps)) {
		if (!packages.has(name)) packages.set(name, info.version);
		walk(info.dependencies);
	}
};
walk(tree.dependencies);

// Code adapted from other projects (not packages), with its license.
const ADAPTED = `
## thinking-orbs

Several idle animations of the graph (src/animations.ts) are adapted from the dotted orbs of
thinking-orbs by Jakub Antalik: https://github.com/Jakubantalik/thinking-orbs

License: MIT

\`\`\`
MIT License

Copyright (c) 2026 Jakub Antalik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
\`\`\`
`;

let out = '# Third-party notices\n\nLiterature Graph bundles code from the following packages into `main.js`.\n';
for (const [name, version] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
	const dir = join('node_modules', name);
	const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
	out += `\n## ${name} ${version}\n\nLicense: ${pkg.license ?? 'see below'}\n`;
	if (licenseFile && existsSync(join(dir, licenseFile))) {
		out += `\n\`\`\`\n${readFileSync(join(dir, licenseFile), 'utf8').trim()}\n\`\`\`\n`;
	}
}
out += '\n# Adapted code\n\nLiterature Graph also contains code adapted from the following projects.\n' + ADAPTED;
writeFileSync('THIRD-PARTY-NOTICES.md', out);
console.log(`THIRD-PARTY-NOTICES.md: ${packages.size} packages`);
