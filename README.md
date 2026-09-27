# Literature Graph.md

An Obsidian plugin for literature notes written in Markdown (for example, papers converted from PDF).

> **Status: early development.** The plugin does not do anything useful yet.

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
