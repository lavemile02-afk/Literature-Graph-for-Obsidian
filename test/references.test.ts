import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localizeReference } from '../src/references';

const cases: [string, string][] = [
	[
		'Bourgeois, B., Vanasse, A., González, E., Andersen, R. et Poulin, M. (2016). Threshold dynamics. _Journal of Applied Ecology_, _53_(6), 1704–1713.',
		'Bourgeois, B., Vanasse, A., González, E., Andersen, R., & Poulin, M. (2016). Threshold dynamics. _Journal of Applied Ecology_, _53_(6), 1704–1713.',
	],
	[
		'Batzer, D. P. et Baldwin, A. H. (dir.). (2012). _Wetland habitats of North America_. University of California Press.',
		'Batzer, D. P., & Baldwin, A. H. (Eds.). (2012). _Wetland habitats of North America_. University of California Press.',
	],
	['Craft, C. (2022). _Creating and restoring wetlands_ (2e éd.). Elsevier.', 'Craft, C. (2022). _Creating and restoring wetlands_ (2nd ed.). Elsevier.'],
	[
		'Howie, S. A. (2013). _Bogs and their laggs_ (Thèse de doctorat). Simon Fraser University.',
		'Howie, S. A. (2013). _Bogs and their laggs_ [Doctoral dissertation, Simon Fraser University].',
	],
	['Lehnhart-Barnett, H. T. (2024). Water deficit [Prépublication]. Authorea.', 'Lehnhart-Barnett, H. T. (2024). Water deficit [Preprint]. Authorea.'],
	[
		'Smith, J. (2020). A chapter. Dans A. Doe et B. Roe (dir.), _A book_ (p. 10–20). Publisher.',
		'Smith, J. (2020). A chapter. In A. Doe & B. Roe (Eds.), _A book_ (pp. 10–20). Publisher.',
	],
	['van Dam, A. A. (2023). What drives wetland loss? Dans _Ramsar wetlands_ (p. 259–306). Elsevier.', 'van Dam, A. A. (2023). What drives wetland loss? In _Ramsar wetlands_ (pp. 259–306). Elsevier.'],
	['Organisation, X. (s.d.). A page. Food and Agriculture.', 'Organisation, X. (n.d.). A page. Food and Agriculture.'],
];

test('converts references from French to English', () => {
	for (const [fr, en] of cases) assert.equal(localizeReference(fr, 'en'), en);
});

test('converts references from English to French', () => {
	for (const [fr, en] of cases) assert.equal(localizeReference(en, 'fr'), fr);
});

test('leaves "et" and "and" in titles alone', () => {
	const ref = 'Rydin, H. et Jeglum, J. (2013). _The biology of peatlands et al_. Oxford University Press.';
	assert.equal(localizeReference(localizeReference(ref, 'en'), 'fr'), ref);
});
