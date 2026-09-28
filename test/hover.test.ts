import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passageExcerpt, plainText } from '../src/hover';

test('makes Markdown readable as plain text', () => {
	assert.equal(plainText('- **Bold** and *it*, [link](x.md), <sup>1</sup>, ![](img.png)'), 'Bold and it, link, 1,');
});

test('shows a passage with its context, on its own lines only', () => {
	const text = 'Heading\n- 3. First point, with its end. The passage is here and then more text.\n- 4. Next point.';
	const from = text.indexOf('The passage');
	const excerpt = passageExcerpt(text, { from, to: from + 'The passage is here'.length });
	assert.equal(excerpt.passage, 'The passage is here');
	assert.equal(excerpt.before, '3. First point, with its end.');
	assert.equal(excerpt.after, 'and then more text.');
});

test('shortens very long passages and marks cut context', () => {
	const long = `${'word '.repeat(400)}`;
	const text = `${'context '.repeat(100)}${long}${'after '.repeat(100)}`;
	const from = text.indexOf('word');
	const excerpt = passageExcerpt(text, { from, to: from + long.length });
	assert.ok(excerpt.passage.includes(' … '));
	assert.ok(excerpt.before.startsWith('… '));
	assert.ok(excerpt.after.endsWith(' …'));
});
