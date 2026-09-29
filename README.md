# Literature Graph

An Obsidian plugin for literature notes written in Markdown (for example, papers converted from PDF).

Explore how the works of your vault cite each other, and the works outside it that they cite, in a panel and a graph view of their own, built from the reference lists of your notes, from citation links and from OpenAlex.

## Features

- **Literature graph.** A graph view of the citations between your literature notes, and optionally the works outside your vault they cite (with or without a DOI), in the style of Obsidian's graph view; also as a local graph around the active note, following the works it cites, the works citing it, or both.
- **Citations panel.** The works a note cites and the notes that cite it, on two levels, including the reference lists of papers converted from PDF.
- **Reference lists read from your notes**, even when the conversion damaged them, and linked to the notes of your vault.
- **Bibliographic data from OpenAlex**, cached for offline use (network access can be turned off).

Literature Graph works on its own. With [Better Citations](https://github.com/lavemile02-afk/Better_Citations_for_Obsidian), you can also cite a passage of a note with a link that opens it exactly there, and these links become citations in the graph (see [Citation links](#citation-links)).

## Installation

The plugin is not yet in Obsidian's community plugin directory. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/lavemile02-afk/Literature-Graph-for-Obsidian/releases/latest), put them in `<vault>/.obsidian/plugins/literature-graph/`, then enable **Literature Graph** in **Settings → Community plugins**. It requires Obsidian 1.13.7 or later, on desktop.

Then, in the plugin settings, choose the **literature folder** (the folder of your literature notes) and the **citation language** of the labels, and check the names of the properties that hold each work's citation text, authors, year, title and DOI.

## Citation links

A citation link is an ordinary Markdown link whose text is the citation and whose URL points to a note (and a passage in it), as written by [Better Citations](https://github.com/lavemile02-afk/Better_Citations_for_Obsidian):

```markdown
([Bourgeois et al., 2016](obsidian://cite?note=Bourgeois%20et%20al.%2C%202016&q=Once%20canopy%20cover%20passed%20a%20threshold))
```

Literature Graph reads these links in every note, with or without Better Citations, and counts each as a citation of the linked work (by its `note`, or by its `doi` for a work outside your vault): they are edges of the graph and entries of the citations panel. Because they are URLs, Obsidian does not treat them as internal links, so they stay out of its own graph view and backlinks.

With Better Citations installed, a cited passage listed in the citations panel opens at the passage, and hover previews of works cited by DOI only show their title from Literature Graph's OpenAlex data; without it, the panel opens the cited work at the beginning of its note.

## Citations panel

**Open citations panel** (command or ribbon icon) shows, in the right sidebar, for the active note:

- **Cites**: the works it cites, with how many times each is cited. A work of your vault opens at the beginning of its note; a work outside your vault, cited by DOI, opens `https://doi.org/…`; a broken link is shown in red. Expand a work to see the cited passages; click one to open it.
- **Cited by**: the notes that cite it. Expand one to see the lines of its citations; click one to go there.
Each work expands to a second level: its cited passages, its own **References** and the works that **cite it** (the 50 most cited, with the total), from your vault's citation links and from OpenAlex, loaded when you open them. Works cited only by DOI show their title from OpenAlex.

- **References (OpenAlex)**: when the note has a DOI (its DOI property, or else the first `doi.org` link in it), the works that this work cites, from OpenAlex. Works of your vault (matched by DOI) open their note; the others open their DOI.

### Reference lists of converted papers

Literature notes converted from PDF usually end with their reference list ("References", "Literature cited", "Références bibliographiques"…; a book may have one per chapter). The plugin reads these lists, without changing the notes, and links each entry to a note of your vault when it can: by DOI, or else by first author and year **and** most of the title's words (or, without a title, the same author list), so that two works of the same author and year are not confused. An entry that matches no note, or more than one, is not linked. The note's aliases count as other titles: put the original title of a translation there, and the entries citing the original find it. Reference lists damaged by the conversion are read as far as possible (entries broken over two lines, missing headings, escaped or cut DOIs).

- **References (from the note)**: the entries of the active note's reference list, linked when possible (open by default when the note has no DOI).
- **Cited by** also lists the notes whose reference list cites the active note.

The notes' properties give the authors, year and title of each work (see the settings), and only notes in the literature folder are read this way.

## Literature graph

**Open graph** (command or ribbon icon) opens a graph view of your literature: the notes of the literature folder, and the citations between them, never wikilinks, so Obsidian's own graph view stays as it is. A citation between two works of your vault is drawn when it is found in a citation link, in the citing note's reference list, or in OpenAlex (the references of works with a DOI). Arrows point to the cited work, and larger nodes are cited more often.

**Local graph.** **Open local graph** shows, in the right sidebar, the works around the active note, up to one to three citations away (the **Depth** slider), and follows the note you open. **Direction** chooses what it follows: the works the note cites (links), the works citing it (backlinks), or both. A note outside the literature folder, such as a draft that cites works with citation links, is shown at the center with the works it cites.

**Generations.** By default the graph shows the works of your vault (generation 0). With generation 1, it also shows, smaller and in the theme's color for unresolved notes, the works outside your vault that they cite; with generation 2, the works those cite. These come from OpenAlex, and, for generation 1, also from the reference lists of your notes: works without a DOI (books, reports, older papers) are shown too, recognized from one note to another by first author, year and title, without any request (switch **Works without a DOI**). **Hide works without citations** hides the works that cite and are cited by none of the works shown. Since this can mean tens of thousands of works, a work outside the vault is shown only if enough works of the graph cite it (by default at least one), and the graph keeps at most a set number of works (by default 3000), the most cited first; the status line says how many were left out. Clicking a work outside the vault opens its DOI.

**Color groups.** As in Obsidian's graph view, notes can be colored by groups: in the graph's settings panel, **New group**, then a query and a color. They are saved in the plugin settings, where they can also be written one per line as `query = color`; a note takes the color of the first group it matches:

```
tag:#review = #d9a441
[Type:Book] = rgb(120, 170, 220)
path:Theses = hsl(140, 40%, 55%)
```

Queries are `tag:#name` (nested tags included), `path:text`, `file:text`, `[property:value]` (the property contains the value), `[property]` (the property is not empty), or plain text found in the note's name or title. Works outside the vault keep the unresolved-node color.

**Controls.** The panel at the top right filters the works by author, year or title, and changes the generations, the minimum citations and the forces of the layout for as long as the view is open (the defaults are in the plugin settings).

The view looks like Obsidian's graph view and follows your theme (it uses the same `--graph-*` colors). Drag the background to move, scroll to zoom, drag a node to move it, hover a node to highlight its neighbors, and click a node to open its note (Ctrl/Cmd-click: new tab), or the DOI of a work outside your vault. Hovering a work shows, at the bottom left, its title and what a click opens; even a tiny node can be clicked within a few pixels. The gear button opens the settings panel (filter, depth and direction, generations, minimum citations, color groups, forces); it turns into a cross to close the panel, and a click outside the panel closes it too. The graph fits itself to the view while it lays out, until you move or zoom; the **Fit** button (or a double click on the background) fits it again. Where labels would cover one another, only the most important are shown (the hovered work, then the works of your vault, then the most cited).

The layout runs in a background thread (a web worker), and the view draws only when something moves, so even a graph of a few thousand works stays smooth and costs nothing once still, or while its tab is hidden.

## Network use

When **Use OpenAlex** is on (the default), the plugin sends requests to [OpenAlex](https://openalex.org) (`api.openalex.org`), a free and open index of scholarly works, to get bibliographic data: the requests contain DOIs and OpenAlex work ids only, plus the contact email if you set one in the settings. Answers are cached in `openalex-cache.json` in the plugin folder, so they stay available offline and each work is requested only once. Turn **Use OpenAlex** off to make no network requests at all; the cache is still used.

Without an API key, OpenAlex allows each network (IP address) a free budget of $0.10 of usage a day, renewed at midnight UTC; the plugin fetches works by DOI or id in batches of 50, at $0.0001 per batch, so a few hundred works cost well under a cent, but a first large generation-2 graph, or other programs on the same network, can still use it up. When OpenAlex refuses requests, the plugin says so once, stops asking until the budget is back, and keeps using what is cached. A free API key (see [openalex.org](https://openalex.org)) has its own budget, ten times larger ($1 a day): store it with **OpenAlex API key** in the settings, which keeps it in Obsidian's secret storage rather than in the plugin's settings file.

## Development

Requires [Node.js](https://nodejs.org/) (current LTS) and npm.

```bash
npm install      # install dependencies
npm run dev      # rebuild main.js on every change (watch mode)
npm run build    # type-check and build a production main.js
npm run lint     # lint with the Obsidian ESLint rules
npm test         # run the tests (Node's built-in test runner)
```

The source is in `src/` (TypeScript). The build writes `main.js` at the repository root. To test in a vault, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/literature-graph/` and reload the plugin.

The rendering uses [PixiJS](https://pixijs.com) and [d3-force](https://d3js.org/d3-force), bundled into `main.js`. After changing dependencies, run `npm run notices` to update `THIRD-PARTY-NOTICES.md`, which holds the licenses of every bundled package.

The project structure follows the official [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin).

### Releasing

Run `npm version <x.y.z>` (updates `manifest.json` and `versions.json`), then push the commit and the tag. A GitHub Action builds the plugin and creates the release with `main.js`, `manifest.json` and `styles.css`.

## License

[MIT](LICENSE)
