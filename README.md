# Literature Graph.md

An Obsidian plugin for literature notes written in Markdown (for example, papers converted from PDF).

> **Status: early development.** Citation links can be copied from a selection and open the cited passage; the other features are planned.

## Citation links

A citation link is an ordinary Markdown link whose text is the citation and whose URL points to a note and a passage in it:

```markdown
([Bourgeois et al., 2016](obsidian://cite?note=Bourgeois%20et%20al.%2C%202016&q=Once%20canopy%20cover%20passed%20a%20threshold))
```

Clicking it opens the note `Bourgeois et al., 2016`, scrolls to the passage that starts with "Once canopy cover passed a threshold" and selects it. Parameters:

| Parameter | Meaning |
|---|---|
| `note` | Note name (resolved like a `[[wikilink]]`) or path from the vault root. |
| `q` | Start of the cited passage, copied word for word from the note's Markdown. Six to fifteen words are usually enough to be unique. Always the last parameter. |
| `qe` | Optional. End of the passage, a few words copied from the note. The passage then runs from `q` to `qe`. |
| `occ` | Optional. Which occurrence of the passage to open, if it appears more than once (starting at 1). |
| `doi` | Optional. DOI of the cited work. If the note does not exist, the link opens `https://doi.org/<doi>` instead. A work that is not in your vault can be cited with `doi` alone. |

Values are percent-encoded, like in any URL. This is the canonical form: it works everywhere, including from other applications when Obsidian is installed. For hand-written links, a readable form between angle brackets is also accepted:

```markdown
([Bourgeois et al., 2016](<obsidian://cite?note=Bourgeois et al., 2016&q=Once canopy cover passed a threshold>))
```

The readable form breaks if the passage contains `>` or a line break, and it may not work outside Obsidian.

### Creating a citation link

In the note of a work, select the passage you want to cite, right-click it and choose **Copy citation link** (or run the command **Copy citation link to selection**, which you can bind to a hotkey). Paste the link where you write. For a long selection, the link keeps its first words (`q`) and last words (`qe`), and the whole passage is selected or highlighted when the link is opened. If the start of the passage appears more than once in the note, the link says which occurrence (`occ`).

The text of the link comes from the work's properties:

1. the citation text property (by default `Citation_texte`), such as `(Smith et al., 2020)`;
2. otherwise the authors and year properties (by default `Auteurs`, as `Family, I., Family, I.`, and `Annee`);
3. otherwise the note name.

The property names, and the language of the citation ("Smith & Jones" or "Smith et Jones"), can be changed in the plugin settings.

### Opening a citation link

Clicking a citation link opens the note and selects the passage (editing view) or highlights it for a few seconds (reading view). Ctrl/Cmd-click or middle-click opens it in a new tab. The passage is found even if line breaks, hyphenation, emphasis or HTML tags differ; if it was changed since, the closest text is shown with a notice.

### Checking and exporting

- **Check citations in this note** lists the citation links whose note or passage cannot be found, or whose passage was changed, with a link to each line.
- **Copy note without citation links** copies the note with each link replaced by its text, "(Smith et al., 2020)", for pasting into a word processor, where `obsidian://` links would only work with Obsidian installed.

### Reference list

**Insert reference list** inserts, at the cursor, the reference list of the works cited by the note's citation links, sorted alphabetically as in APA style. Each reference comes from the work's reference property (by default `Citation`), converted to the citation language: "&" or "et", "(Eds.)" or "(dir.)", "In" or "Dans", "(2nd ed.)" or "(2e éd.)", "[Doctoral dissertation, …]" or "(Thèse de doctorat)", "[Preprint]" or "[Prépublication]", "n.d." or "s.d.". When several works share the same in-text citation, they get letters (2016a, 2016b) and a notice says which letters to use in the text.

### For scripts and AI agents

Citation links are plain text, so a script or an AI assistant can write and check them without Obsidian:

1. Copy six to fifteen consecutive words of the passage, word for word, from the note's Markdown (not from the PDF).
2. Percent-encode `note` and `q` (and `qe`), including `(`, `)`, `!`, `'` and `*`, with a library function (for example `encodeURIComponent` plus those five characters, or Python's `urllib.parse.quote(value, safe="")`). Put `q` last.
3. Check the link: decode `q` and make sure it occurs in the note after this normalization of both texts, which is what the plugin does: lower case; accents removed (Unicode NFKD, combining marks dropped); `*`, `_`, `` ` ``, `~` and `\` removed; HTML tags removed (`<br>`, `<p>`, `<li>`, `<td>`… count as a space); typographic quotes made straight; every dash or hyphen removed together with the whitespace around it; every other run of whitespace turned into one space. A link whose passage cannot be found this way should not be delivered.

Because citation links are URLs, Obsidian does not treat them as internal links: nothing is added to the cited note, and they do not appear in the graph view or in backlinks.

## Planned features

- **Passage citation links.** Cite a paper as usual, "(Author et al., 2016)", with a link that opens the paper's note at the exact cited passage. The link is a plain `obsidian://cite?...` URL: nothing is added to the cited note, and the link does not appear in Obsidian's graph view or backlinks.
- **Cited works panel.** A sidebar listing the works cited by the active note and the notes that cite it, on two levels.
- **Literature graph.** A separate graph view of citations between your literature notes, and optionally the works they cite that are not in your vault.
- **Bibliographic data from OpenAlex** for works outside your vault (network access, can be turned off).

## Installation

Not yet published in the community plugin directory. To try it, copy `main.js`, `manifest.json` and `styles.css` from a release into `<vault>/.obsidian/plugins/literature-graph-md/`, then enable the plugin in **Settings → Community plugins**.

## Development

Requires [Node.js](https://nodejs.org/) (current LTS) and npm.

```bash
npm install      # install dependencies
npm run dev      # rebuild main.js on every change (watch mode)
npm run build    # type-check and build a production main.js
npm run lint     # lint with the Obsidian ESLint rules
```

The source is in `src/` (TypeScript). The build writes `main.js` at the repository root. To test in a vault, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/literature-graph-md/` and reload the plugin.

The project structure follows the official [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin).

### Releasing

Run `npm version <x.y.z>` (updates `manifest.json` and `versions.json`), then push the commit and the tag. A GitHub Action builds the plugin and creates the release with `main.js`, `manifest.json` and `styles.css`.

## License

[MIT](LICENSE)
