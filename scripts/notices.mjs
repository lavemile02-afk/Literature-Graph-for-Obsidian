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
writeFileSync('THIRD-PARTY-NOTICES.md', out);
console.log(`THIRD-PARTY-NOTICES.md: ${packages.size} packages`);
