/**
 * BibTeX parser for the RefHub backend.
 *
 * Ported from refhub.io/src/lib/bibtex.ts (brace-balanced field extractor).
 * Exports a single function: parseBibtex(content) -> publication objects[].
 */

function parseField(content) {
  let value = content.trim();
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  return value.replace(/\{([^}]*)\}/g, "$1").trim();
}

function parseBibtexEntry(entry) {
  const headerMatch = entry.match(/@(\w+)\s*\{\s*([^,\s]+)\s*,/i);
  if (!headerMatch) return null;

  const type = headerMatch[1].toLowerCase();
  const key = headerMatch[2];

  const contentStart = entry.indexOf(",") + 1;
  const contentEnd = entry.lastIndexOf("}");
  if (contentStart <= 0 || contentEnd <= contentStart) return null;

  const content = entry.slice(contentStart, contentEnd);
  const fields = {};

  const fieldPattern = /(\w+)\s*=\s*(["{])/g;
  let match;
  const fieldStarts = [];

  while ((match = fieldPattern.exec(content)) !== null) {
    fieldStarts.push({
      field: match[1].toLowerCase(),
      pos: match.index + match[0].length - 1,
      delimiter: match[2],
    });
  }

  for (let i = 0; i < fieldStarts.length; i++) {
    const { field, pos, delimiter } = fieldStarts[i];
    const nextPos = i + 1 < fieldStarts.length ? fieldStarts[i + 1].pos : content.length;

    let value = "";
    let j = pos + 1;

    if (delimiter === "{") {
      let depth = 1;
      while (j < nextPos && depth > 0) {
        if (content[j] === "{") depth++;
        else if (content[j] === "}") depth--;
        if (depth > 0) value += content[j];
        j++;
      }
    } else {
      while (j < nextPos) {
        if (content[j] === '"' && (j === pos + 1 || content[j - 1] !== "\\")) break;
        value += content[j];
        j++;
      }
    }

    if (value.trim()) {
      fields[field] = parseField(value);
    }
  }

  return { type, key, fields };
}

export function parseBibtex(bibtexContent) {
  const entries = [];
  let i = 0;
  const content = bibtexContent;

  while (i < content.length) {
    const atIndex = content.indexOf("@", i);
    if (atIndex === -1) break;

    const afterAt = content.slice(atIndex + 1);
    const typeMatch = afterAt.match(/^(\w+)\s*\{/);
    if (!typeMatch) {
      i = atIndex + 1;
      continue;
    }

    const braceStart = atIndex + 1 + typeMatch[0].indexOf("{");
    let braceDepth = 0;
    let entryEnd = -1;

    for (let j = braceStart; j < content.length; j++) {
      if (content[j] === "{") braceDepth++;
      else if (content[j] === "}") {
        braceDepth--;
        if (braceDepth === 0) {
          entryEnd = j + 1;
          break;
        }
      }
    }

    if (entryEnd > atIndex) {
      entries.push(content.slice(atIndex, entryEnd));
      i = entryEnd;
    } else {
      i = atIndex + 1;
    }
  }

  const publications = [];

  for (const entry of entries) {
    const parsed = parseBibtexEntry(entry);
    if (!parsed) continue;

    const { type, key, fields } = parsed;

    const authors = fields.author ? fields.author.split(/\s+and\s+/i).map((a) => a.trim()) : [];
    const editor = fields.editor ? fields.editor.split(/\s+and\s+/i).map((e) => e.trim()) : [];
    const keywords = fields.keywords ? fields.keywords.split(",").map((k) => k.trim()).filter(Boolean) : [];
    const year = fields.year ? parseInt(fields.year, 10) : undefined;

    publications.push({
      title: fields.title?.trim() || "Untitled",
      authors,
      year: year && !isNaN(year) ? year : undefined,
      journal: fields.journal || undefined,
      volume: fields.volume || undefined,
      issue: fields.number || undefined,
      pages: fields.pages || undefined,
      doi: fields.doi || undefined,
      url: fields.url || undefined,
      abstract: fields.abstract || undefined,
      bibtex_key: key,
      publication_type: type,
      booktitle: fields.booktitle || undefined,
      chapter: fields.chapter || undefined,
      edition: fields.edition || undefined,
      editor: editor.length > 0 ? editor : undefined,
      howpublished: fields.howpublished || undefined,
      institution: fields.institution || undefined,
      number: fields.number || undefined,
      organization: fields.organization || undefined,
      publisher: fields.publisher || undefined,
      school: fields.school || undefined,
      series: fields.series || undefined,
      type: fields.type || undefined,
      eid: fields.eid || undefined,
      isbn: fields.isbn || undefined,
      issn: fields.issn || undefined,
      keywords: keywords.length > 0 ? keywords : undefined,
    });
  }

  return publications;
}
