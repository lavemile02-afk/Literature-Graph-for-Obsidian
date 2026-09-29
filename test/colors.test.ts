import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexColor, mixColor } from '../src/colors';

test('mixes two colors channel by channel', () => {
	assert.equal(mixColor(0xffffff, 0x000000, 0), 0xffffff);
	assert.equal(mixColor(0xffffff, 0x000000, 1), 0x000000);
	assert.equal(mixColor(0xc8a878, 0x282018, 0.5), 0x786448);
	assert.equal(mixColor(0x0000ff, 0xff0000, 0.25), 0x4000bf);
});

test('writes a color number as #rrggbb', () => {
	assert.equal(hexColor(0x0a0b0c), '#0a0b0c');
	assert.equal(hexColor(0xd9a441), '#d9a441');
});
