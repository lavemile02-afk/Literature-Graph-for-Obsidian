import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bibliographyEntries, entryMatches, familyOf, isReferenceHeading, nameKey, parseEntry } from '../src/bibliography';

test('recognizes reference-list headings in many forms', () => {
	for (const heading of [
		'References',
		'REFERENCES',
		'**References**',
		'<span id="page-252-0"></span>**References**',
		'LITERATURE CITED',
		'Références bibliographiques',
		'7. References',
	]) {
		assert.ok(isReferenceHeading(heading), heading);
	}
	assert.ok(!isReferenceHeading('Results and references to the literature'));
});

test('reads the entries of each reference section, and only those', () => {
	const note = [
		'# Paper',
		'Text citing (Smith 2001).',
		'## References',
		'- Smith, J. (2001) A title about peat. Journal, 1, 1-2. https://doi.org/10.1000/ABC.1.',
		'- Doe, A. & Roe, B. (1999). Another title. Journal, 2, 3-4.',
		'# Appendix',
		'- Not a reference, 2001.',
	].join('\n');
	const entries = bibliographyEntries(note);
	assert.equal(entries.length, 2);
	assert.equal(entries[0]?.firstAuthor, 'Smith');
	assert.equal(entries[0]?.year, '2001');
	assert.equal(entries[0]?.doi, '10.1000/abc.1');
	assert.deepEqual(entries[1]?.authors, ['doe', 'roe']);
});

test('reads authors in several styles', () => {
	assert.deepEqual(parseEntry('Price , J.S.and Maloney , D.A.( 1994 ) Hydrology of a bog.', 0)?.authors, ['price', 'maloney']);
	assert.deepEqual(parseEntry('Price, J. S., A. L. Heathwaite, and A. J. Baird. 2003. Hydrological processes.', 0)?.year, '2003');
	assert.equal(parseEntry('Van den Brink, P.J. & Ter Braak, C.J.F. (1999) Principal response curves.', 0)?.firstAuthor, 'Van den Brink');
	assert.ok(parseEntry('Smith, J. (2001) et al. something', 0)?.year);
});

test('matches an entry to a work only with the title, not the author and year alone', () => {
	const priceMaloney = {
		authors: ['price', 'maloney'],
		year: '1994',
		title: 'Hydrology of a patterned bog-fen complex in southeastern Labrador',
		doi: null,
	};
	const same = parseEntry('Price, J.S., Maloney, D.A., 1994. Hydrology of a patterned bog-fen complex in southeastern Labrador. Nordic Hydrology.', 0);
	const other = parseEntry('Price, J.S. (1994) Evapotranspiration from a lakeshore Typha marsh on Lake Ontario.', 0);
	assert.ok(same && entryMatches(same, priceMaloney));
	assert.ok(other && !entryMatches(other, priceMaloney));
});

test('reduces names for comparison', () => {
	assert.equal(nameKey('González-Pérez'), 'gonzalezperez');
});

test('finds family names in every author style', () => {
	assert.equal(familyOf('Keller J'), 'Keller');
	assert.equal(familyOf('R. A. Gatenby'), 'Gatenby');
	assert.equal(familyOf('Heikkinen J. E. P.'), 'Heikkinen');
	assert.equal(familyOf('Van den Brink'), 'Van den Brink');
	assert.equal(familyOf('WHO'), 'WHO');
	assert.equal(familyOf('J.S.'), '');
	assert.deepEqual(parseEntry('Keller J, Bauers AK, et al. 2006. Nutrient control of microbial carbon cycling.', 0)?.authors, ['keller', 'bauers']);
});

test('keeps the parentheses of a DOI', () => {
	assert.equal(
		parseEntry('Price, J. S. (1997). Soil moisture. J. Hydrol. https://doi.org/10.1016/S0022-1694(97)00037-1.', 0)?.doi,
		'10.1016/s0022-1694(97)00037-1',
	);
});

test('reads entries that start with an anchor or a bare number, under linked headings', () => {
	const note = [
		'# [References](#page-49-0)',
		'<span id="page-14-2"></span>Autio, A., Ala-Aho, P. (2020). Implications of peat soil conceptualization.',
		'- 1 IUCN (1980) World Conservation Strategy.',
		'# FURTHER READINGS',
		'- Smith, J. (2001). A further reading about peat.',
	].join('\n');
	const entries = bibliographyEntries(note);
	assert.deepEqual(
		entries.map((e) => [e.firstAuthor, e.year]),
		[
			['Autio', '2020'],
			['IUCN', '1980'],
			['Smith', '2001'],
		],
	);
});

test('reads DOIs escaped by the conversion or percent-encoded', async () => {
	const { parseEntry } = await import('../src/bibliography');
	const escaped = parseEntry(
		'Price, J. S. (1997). Soil moisture, water tension. _J. Hydrol._, 202, 21–32. https://doi.org/10.1016/s0022-1694\\(97\\)00037-1',
		0,
	);
	assert.equal(escaped?.doi, '10.1016/s0022-1694(97)00037-1');
	const encoded = parseEntry(
		'Price, J. S. (1996). Hydrology and microclimate. https://doi.org/10.1002/(sici)1099-1085(199610)10:10%3c1263::aid-hyp458%3e3.0.co;2-1',
		0,
	);
	assert.ok(encoded?.doi?.startsWith('10.1002/(sici)1099-1085(199610)10:10'));
});

test('matches an entry whose DOI was cut short, by author, year and title', async () => {
	const { entryMatches, parseEntry } = await import('../src/bibliography');
	const work = {
		authors: ['price', 'whitehead'],
		year: '2001',
		title: 'Developing hydrologic thresholds for Sphagnum recolonization on an abandoned cutover bog',
		doi: '10.1672/0277-5212(2001)021[0032:dhtfsr]2.0.co;2',
	};
	const cut = parseEntry(
		'Price, J. S., & Whitehead, G. S. (2001). Developing hydrologic thresholds for Sphagnum recolonization on an abandoned cutover bog. Wetlands, 21, 32–40. https://doi.org/10.1672/0277-5212(2001)021[0032:DHTFSR]2.0.CO;2',
		0,
	);
	assert.ok(cut && entryMatches(cut, work));
	// A different DOI still rules the match out, whatever the title.
	const other = parseEntry(
		'Price, J. S., & Whitehead, G. S. (2001). Developing hydrologic thresholds for Sphagnum recolonization on an abandoned cutover bog. https://doi.org/10.1002/hyp.11622',
		0,
	);
	assert.ok(other && !entryMatches(other, work));
});

test('matches the original title of a translation, given as another title', async () => {
	const { entryMatches, parseEntry } = await import('../src/bibliography');
	const entry = parseEntry(
		'Quinty, F., & Rochefort, L. (2003). Peatland restoration guide (2nd ed.). Canadian Sphagnum Peat Moss Association.',
		0,
	);
	const work = { authors: ['quinty', 'rochefort'], year: '2003', title: 'Guide de restauration des tourbières', doi: null };
	assert.ok(entry && !entryMatches(entry, work));
	assert.ok(entry && entryMatches(entry, { ...work, otherTitles: ['Peatland restoration guide'] }));
});

test('counts a title word glued to a short word, not a word inside a longer one', async () => {
	const { titleOverlap } = await import('../src/bibliography');
	assert.equal(titleOverlap('The Biology of Peatlands', 'Rydin, H. et J. Jeglum. 2006. The biology ofpeatlands.'), 1);
	assert.equal(titleOverlap('Peat oxidation', 'Waddington, J.M. 2002. Cutover peatlands: a persistent source.'), 0);
});

test('joins an entry broken over two list items', async () => {
	const { bibliographyEntries } = await import('../src/bibliography');
	const note = [
		'## References',
		'- Gorham, E. 1991. Northern peatlands: role in the carbon',
		'',
		'- cycle and probable responses to climatic warming. Ecological Applications **1**:182–195.',
		'- Harte, J. 1995. Global warming and soil microclimate. Ecological Applications **5**:132–150.',
	].join('\n');
	const entries = bibliographyEntries(note);
	assert.equal(entries.length, 2);
	assert.match(entries[0]?.text ?? '', /carbon cycle and probable responses/);
	assert.equal(entries[0]?.line, 1);
});

test('keeps a reference section open over its sub-headings, and reads <CAPITALS> headings', async () => {
	const { bibliographyEntries, isReferenceHeading } = await import('../src/bibliography');
	assert.ok(isReferenceHeading('**<BIBLIOGRAPHIE>**'));
	assert.ok(isReferenceHeading('<sup>106</sup> Références directes'));
	const note = [
		'### **7 Références**',
		'### *Général*',
		'Chapman, D. 2002. Peatlands and Environmental Change. John Wiley and Sons, Chichester.',
		'Gorham, E. 1991. Northern peatlands: role in the carbon cycle. Ecological Applications.',
		'### *Restauration*',
		'Price, J. S. 1996. Hydrology and microclimate of a partly restored cutover bog, Québec.',
		'Price, J. S. 1997. Soil moisture, water tension, and water table relationships.',
		'### Annexe',
		'This appendix describes the sites visited in 2002 and their vegetation.',
		'Its tables list the species found in 1999 in each plot.',
	].join('\n');
	assert.deepEqual(
		bibliographyEntries(note).map((e) => e.firstAuthor),
		['Chapman', 'Gorham', 'Price', 'Price'],
	);
});

test('gives the same key to one work cited in different styles', async () => {
	const { entryKey, entryTitle, parseEntry } = await import('../src/bibliography');
	const a = parseEntry('Quinty, F., & Rochefort, L. (2003). *Peatland restoration guide* (2nd ed.). Université Laval.', 0);
	const b = parseEntry('Quinty F, Rochefort L. 2003. Peatland Restoration Guide, Second edn. Canadian Sphagnum Peat Moss Association.', 0);
	const c = parseEntry('Gorham, E. 1991. Northern peatlands: role in the carbon cycle. Ecol. Appl. 1: 182–195.', 0);
	assert.ok(a && b && c);
	assert.equal(entryTitle(c), 'Northern peatlands: role in the carbon cycle');
	assert.equal(entryKey(a), 'quinty|2003|peatland restoration guide');
	assert.equal(entryKey(a), entryKey(b));
	assert.notEqual(entryKey(a), entryKey(c));
});

test('reads bold numbers and leaves editor marks out of the authors', async () => {
	const { parseEntry } = await import('../src/bibliography');
	const numbered = parseEntry('**34** Bell, J.N.B. and Tallis, J.H. (1973) *J. Ecol.* 62, 75–95', 0);
	assert.deepEqual([numbered?.firstAuthor, numbered?.year, numbered?.authors], ['Bell', '1973', ['bell', 'tallis']]);
	const edited = parseEntry('Stearns SC (ed) (1999) Evolution in health and disease. Oxford University Press, Oxford', 0);
	assert.deepEqual(edited?.authors, ['stearns']);
});

test('reads a reference list whose heading was lost, but not scattered citations', async () => {
	const { bibliographyEntries } = await import('../src/bibliography');
	const refs = [
		'**Bragg, O. M. 1995.** Towards an ecohydrological basis for raised mire restoration.',
		'**Campbell, D. R., Lavoie, C. and Rochefort, L. 2002.** Wind erosion and surface stability.',
		'**Environment Canada. 1993.** Canadian climate normals, 1961–1990.',
		'**Gilmer, A. J., Ward, S. M. and Farrell, E. P. 1998.** Restoration peatland carbon sequestration.',
		'**Gorham, E. 1991.** Northern peatlands: role in the carbon cycle.',
		'**Price, J. S. 1997.** Soil moisture, water tension, and water table relationships.',
	];
	const note = ['# Results', 'Price (1996) found that the water table fell.', '', '# ACKNOWLEDGEMENTS', 'Thanks to A. B.', '', ...refs.flatMap((r) => [r, ''])].join('\n');
	const entries = bibliographyEntries(note);
	assert.equal(entries.length, 5); // "Environment Canada. 1993." does not start like a person's name
	assert.ok(entries.every((e) => e.line >= 6));
	// Fewer than five reference-like lines in a row are not a reference list.
	assert.equal(bibliographyEntries(['# Text', ...refs.slice(0, 3)].join('\n')).length, 0);
});
