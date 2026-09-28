import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApaWork, apaCitations, compareApa, parseAuthors } from '../src/apa';

const work = (id: string, authors: string, year: string, title = id): ApaWork => ({
	id,
	authors: parseAuthors(authors),
	year,
	title,
});

test('reads author lists with initials, hyphens and short surnames', () => {
	assert.deepEqual(parseAuthors('Bourgeois, B., Poulin, M.-C., Li, X., Wang, Y'), [
		{ family: 'Bourgeois', initials: 'B.' },
		{ family: 'Poulin', initials: 'M.-C.' },
		{ family: 'Li', initials: 'X.' },
		{ family: 'Wang', initials: 'Y' },
	]);
});

test('names works with more authors when "et al." citations collide (APA 8.18)', () => {
	const a = work('a', 'Bourgeois, B., Vanasse, A., González, E., Andersen, R., Poulin, M.', '2016', 'Threshold dynamics');
	const b = work('b', 'Bourgeois, B., González, E., Vanasse, A., Aubin, I., Poulin, M.', '2016', 'Spatial processes');
	const c = apaCitations([a, b], 'en');
	assert.equal(c.get('a')?.label, 'Bourgeois, Vanasse, et al., 2016');
	assert.equal(c.get('b')?.label, 'Bourgeois, González, et al., 2016');
	assert.equal(c.get('a')?.letter, '');
	const fr = apaCitations([a, b], 'fr');
	assert.equal(fr.get('a')?.label, 'Bourgeois, Vanasse et al., 2016');
});

test('writes every name when only the last author differs', () => {
	const a = work('a', 'Hasan, N., Liang, Y., Kahn, J., Jones-Miller, T.', '2015');
	const b = work('b', 'Hasan, N., Liang, Y., Kahn, J., Weintraub, G.', '2015');
	const c = apaCitations([a, b], 'en');
	assert.equal(c.get('a')?.label, 'Hasan, Liang, Kahn, & Jones-Miller, 2015');
	assert.equal(c.get('b')?.label, 'Hasan, Liang, Kahn, & Weintraub, 2015');
});

test('gives letters only to works with the same authors and year, in title order', () => {
	const a = work('a', 'Price, J. S.', '1998', 'Methods for restoration of cutover peatlands');
	const b = work('b', 'Price, J. S.', '1998', 'Energy and moisture considerations');
	const c = work('c', 'Price, J. S., Rochefort, L., Quinty, F.', '1998', 'Another work');
	const r = apaCitations([a, b, c], 'en');
	assert.equal(r.get('b')?.label, 'Price, 1998a');
	assert.equal(r.get('a')?.label, 'Price, 1998b');
	assert.equal(r.get('c')?.label, 'Price et al., 1998');
});

test('uses letters for identical "et al." author lists', () => {
	const a = work('a', 'Kapoor, A., Bloom, B., Montez, C.', '2017', 'Beta study');
	const b = work('b', 'Kapoor, A., Bloom, B., Montez, C.', '2017', 'Alpha study');
	const r = apaCitations([a, b], 'en');
	assert.equal(r.get('b')?.label, 'Kapoor et al., 2017a');
	assert.equal(r.get('a')?.label, 'Kapoor et al., 2017b');
});

test('adds initials when different first authors share a surname (APA 8.20)', () => {
	const r = apaCitations([work('a', 'Taylor, J. M.', '2020'), work('b', 'Taylor, A.', '2019')], 'en');
	assert.equal(r.get('a')?.label, 'J. M. Taylor, 2020');
	assert.equal(r.get('b')?.label, 'A. Taylor, 2019');
});

test('names two authors with "&" in English and "et" in French', () => {
	const w = work('a', 'Gorham, E., Rochefort, L.', '2003');
	assert.equal(apaCitations([w], 'en').get('a')?.label, 'Gorham & Rochefort, 2003');
	assert.equal(apaCitations([w], 'fr').get('a')?.label, 'Gorham et Rochefort, 2003');
});

test('orders the reference list as APA does', () => {
	const works = [
		work('browning', 'Browning, A.', '2000'),
		work('brown2', 'Brown, J., Adams, B.', '1990'),
		work('brown1', 'Brown, J.', '2005'),
		work('nd', 'Brown, J.', 'n.d.'),
		work('the', 'Carter, E.', '2001', 'The zebra'),
		work('apple', 'Carter, E.', '2001', 'Apple trees'),
		work('vanandel', 'van Andel, J.', '2012'),
	];
	assert.deepEqual(
		[...works].sort(compareApa).map((w) => w.id),
		['nd', 'brown1', 'brown2', 'browning', 'apple', 'the', 'vanandel'],
	);
});
