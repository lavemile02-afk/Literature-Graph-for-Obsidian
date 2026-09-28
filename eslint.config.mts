import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'scripts',
		'.test-build',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// node:test registers tests with test(), whose promise is not awaited.
		files: ['test/**/*.ts'],
		rules: { '@typescript-eslint/no-floating-promises': 'off' },
	},
	{
		rules: {
			// "OpenAlex" is a proper name (https://openalex.org), "APA" an acronym.
			'obsidianmd/ui/sentence-case': ['warn', { ignoreWords: ['OpenAlex', 'APA'] }],
		},
	},
);
