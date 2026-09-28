import assert from 'node:assert/strict';
import { test } from 'node:test';
import { citationUrl } from '../src/citationLink';
import { citationLinksIn, markdownLinksInLine, withCanonicalCitationLinks, withoutCitationLinks } from '../src/links';

test('finds Markdown links, with balanced parentheses and angle brackets', () => {
	const line = 'See ([A, 2016](obsidian://cite?note=A%20(1)&q=x)) and [B](<obsidian://cite?note=B b&q=y z>).';
	const links = markdownLinksInLine(line);
	assert.deepEqual(
		links.map((l) => [l.text, l.url]),
		[
			['A, 2016', 'obsidian://cite?note=A%20(1)&q=x'],
			['B', 'obsidian://cite?note=B b&q=y z'],
		],
	);
	assert.equal(line.slice(links[0]?.from, links[0]?.to), '[A, 2016](obsidian://cite?note=A%20(1)&q=x)');
});

test('finds citation links outside code blocks only', () => {
	const text = [
		'Cited ([A, 2016](obsidian://cite?note=A&q=one)).',
		'```',
		'([B, 2017](obsidian://cite?note=B&q=two))',
		'```',
		'A [normal link](https://example.org).',
	].join('\n');
	const links = citationLinksIn(text);
	assert.equal(links.length, 1);
	assert.equal(links[0]?.target.note, 'A');
	assert.equal(links[0]?.line, 0);
});

test('replaces citation links by their text for export', () => {
	assert.equal(
		withoutCitationLinks('As shown ([Smith et al., 2020](obsidian://cite?note=S&q=x)), and [web](https://x.org).'),
		'As shown (Smith et al., 2020), and [web](https://x.org).',
	);
});

test('converts readable citation links to the canonical encoded form', () => {
	const text = [
		'One ([A, 2016](<obsidian://cite?note=A b, 2016 (1)&q=models (Hobbs & Suding 2009)>)).',
		'Two ([B, 2017](obsidian://cite?note=B&q=already%20encoded)).',
	].join('\n');
	const result = withCanonicalCitationLinks(text, (link) => citationUrl(link.target));
	assert.equal(result.changed, 1);
	assert.equal(
		result.text.split('\n')[0],
		'One ([A, 2016](obsidian://cite?note=A%20b%2C%202016%20%281%29&q=models%20%28Hobbs%20%26%20Suding%202009%29)).',
	);
	assert.equal(result.text.split('\n')[1], text.split('\n')[1]);
});
