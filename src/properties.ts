/**
 * Properties of notes, read as Obsidian shows them: without regard to case,
 * so a setting "doi" finds a property written "DOI" (and the reverse).
 */

/** The name a note uses for a property: the exact name if it has it, else the same name in another case. */
export function propertyKey(frontmatter: Record<string, unknown> | undefined | null, key: string): string {
	if (!frontmatter || key in frontmatter) return key;
	const lower = key.toLowerCase();
	return Object.keys(frontmatter).find((k) => k.toLowerCase() === lower) ?? key;
}

/** The value of a property of a note, whatever its case. */
export function propertyValue(frontmatter: Record<string, unknown> | undefined | null, key: string): unknown {
	return frontmatter?.[propertyKey(frontmatter, key)];
}
