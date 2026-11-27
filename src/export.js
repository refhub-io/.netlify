// BibTeX keys and escaping here must match refhub.io's src/lib/bibtex.ts, so an API or
// CLI export and a web export of the same paper produce the same citation key and values.
// tests/fixtures/bibtex-golden.json pins the shared behavior; refhub.io keeps an identical
// copy, so change both together.

// LaTeX accent macro -> base letter -> Unicode, and LaTeX letter commands -> Unicode.
const LATEX_ACCENT_MAP = {
  '"': { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", y: "ÿ", A: "Ä", E: "Ë", I: "Ï", O: "Ö", U: "Ü", Y: "Ÿ" },
  "'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", Y: "Ý" },
  "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù", A: "À", E: "È", I: "Ì", O: "Ò", U: "Ù" },
  "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û", A: "Â", E: "Ê", I: "Î", O: "Ô", U: "Û" },
  "~": { a: "ã", n: "ñ", o: "õ", A: "Ã", N: "Ñ", O: "Õ" },
  "=": { a: "ā", e: "ē", i: "ī", o: "ō", u: "ū", A: "Ā", E: "Ē", I: "Ī", O: "Ō", U: "Ū" },
  ".": { z: "ż", Z: "Ż" },
  u: { a: "ă", e: "ĕ", g: "ğ", i: "ĭ", o: "ŏ", u: "ŭ", A: "Ă", E: "Ĕ", G: "Ğ", I: "Ĭ", O: "Ŏ", U: "Ŭ" },
  v: { c: "č", d: "ď", e: "ě", l: "ľ", n: "ň", r: "ř", s: "š", t: "ť", z: "ž", C: "Č", D: "Ď", E: "Ě", L: "Ľ", N: "Ň", R: "Ř", S: "Š", T: "Ť", Z: "Ž" },
  H: { o: "ő", u: "ű", O: "Ő", U: "Ű" },
  c: { c: "ç", s: "ş", C: "Ç", S: "Ş" },
  k: { a: "ą", e: "ę", A: "Ą", E: "Ę" },
  r: { a: "å", A: "Å" },
  b: { o: "ø", O: "Ø" },
};

const LATEX_SPECIAL_CHAR_MAP = {
  ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å", o: "ø", O: "Ø", l: "ł", L: "Ł", ss: "ß",
};

const LATEX_ACCENT_CHARS = "\"'`^~=.uvHckrb";

const UNICODE_TO_LATEX = new Map(
  Object.entries(LATEX_ACCENT_MAP)
    .flatMap(([accent, chars]) => Object.entries(chars).map(([base, unicode]) => [unicode, `{\\${accent}{${base}}}`]))
    .concat(Object.entries(LATEX_SPECIAL_CHAR_MAP).map(([command, unicode]) => [unicode, `{\\${command}}`])),
);

const SPECIAL_BIBTEX_CHARS = { "&": "\\&", "%": "\\%", $: "\\$", "#": "\\#", _: "\\_" };

// Characters a BibTeX key can't contain: whitespace and " # % ' ( ) , = { } \ ~
const INVALID_KEY_CHARS = /[\s"#%'(),={}\\~]/g;

/** Decodes LaTeX accent macros and letter commands to Unicode (e.g. M{\"u}ller -> Müller). */
function decodeLatexText(value) {
  let decoded = value;
  const accentClass = LATEX_ACCENT_CHARS.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const toUnicode = (accent, base) => LATEX_ACCENT_MAP[accent]?.[base] ?? base;

  for (let pass = 0; pass < 3; pass++) {
    decoded = decoded
      .replace(new RegExp(String.raw`\{\\([${accentClass}])\s*\{?([A-Za-z])\}?\}`, "g"), (_, accent, base) => toUnicode(accent, base))
      .replace(new RegExp(String.raw`\\([${accentClass}])\s*\{([A-Za-z])\}`, "g"), (_, accent, base) => toUnicode(accent, base))
      .replace(new RegExp(String.raw`\\([${accentClass}])\s*([A-Za-z])`, "g"), (_, accent, base) => toUnicode(accent, base));
  }

  return decoded
    .replace(/\{\\([A-Za-z]+)\}/g, (_, command) => LATEX_SPECIAL_CHAR_MAP[command] ?? `\\${command}`)
    .replace(/\\([{}&#%_$])/g, "$1")
    .normalize("NFC");
}

/**
 * Keeps a value's braces balanced, which is what stops it from ending its field early.
 * BibTeX counts every brace when it looks for the end of a field, with or without a
 * backslash in front, so an unmatched brace (and its escaping backslash, if any) is
 * replaced by \textbraceleft{} or \textbraceright{}: LaTeX prints a brace, but the
 * replacement contains only balanced braces. Balanced braces (e.g. {GPU}) stay.
 */
function neutralizeUnbalancedBraces(value) {
  const chars = Array.from(value);
  const open = [];
  const unmatched = new Set();
  chars.forEach((char, i) => {
    if (char === "{") open.push(i);
    else if (char === "}") {
      if (open.length) open.pop();
      else unmatched.add(i);
    }
  });
  open.forEach((i) => unmatched.add(i));

  let out = "";
  chars.forEach((char, i) => {
    if (!unmatched.has(i)) {
      out += char;
      return;
    }
    const backslashes = out.match(/\\+$/)?.[0].length ?? 0;
    if (backslashes % 2 === 1) out = out.slice(0, -1); // drop the backslash that escaped this brace
    out += char === "{" ? "\\textbraceleft{}" : "\\textbraceright{}";
  });
  return out;
}

export function escapeBibtexValue(value) {
  const latex = Array.from(String(value).normalize("NFC"), (char) =>
    char.charCodeAt(0) > 0x7f ? UNICODE_TO_LATEX.get(char) ?? char : char,
  ).join("");
  // Line breaks become spaces: a blank line inside a field typesets as a paragraph break.
  return neutralizeUnbalancedBraces(latex.replace(/[\r\n]+/g, " ")).replace(/[&%$#_]/g, (char) => SPECIAL_BIBTEX_CHARS[char]);
}

function normalizeKeyPart(value) {
  return decodeLatexText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function generateBibtexKey(publication) {
  // A stored key is kept as the user wrote it; only characters a key can't contain are dropped.
  const stored = String(publication.bibtex_key || "").replace(INVALID_KEY_CHARS, "");
  if (stored) return stored;

  const firstAuthor = publication.authors?.[0] || "Unknown";
  const lastName = normalizeKeyPart(firstAuthor.split(" ").pop() || "unknown") || "unknown";
  const year = publication.year || "nd";
  const titleWord = normalizeKeyPart(String(publication.title || "").split(" ")[0] || "untitled") || "untitled";

  return `${lastName}${year}${titleWord}`;
}

function sanitizeEntryType(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9:_-]/g, "") || "article";
}

function publicationToBibtex(publication) {
  const fields = [];
  const mapping = [
    ["title", publication.title],
    ["author", publication.authors?.length ? publication.authors.join(" and ") : null],
    ["year", publication.year],
    ["journal", publication.journal],
    ["volume", publication.volume],
    ["number", publication.issue],
    ["pages", publication.pages],
    ["doi", publication.doi],
    ["url", publication.url],
    ["abstract", publication.abstract],
    ["booktitle", publication.booktitle],
    ["chapter", publication.chapter],
    ["edition", publication.edition],
    ["editor", publication.editor?.length ? publication.editor.join(" and ") : null],
    ["howpublished", publication.howpublished],
    ["institution", publication.institution],
    ["organization", publication.organization],
    ["publisher", publication.publisher],
    ["school", publication.school],
    ["series", publication.series],
    ["type", publication.type],
    ["eid", publication.eid],
    ["isbn", publication.isbn],
    ["issn", publication.issn],
    ["keywords", publication.keywords?.length ? publication.keywords.join(", ") : null],
  ];

  for (const [field, value] of mapping) {
    if (value !== null && value !== undefined && value !== "") {
      fields.push(`  ${field} = {${escapeBibtexValue(value)}}`);
    }
  }

  const type = sanitizeEntryType(publication.publication_type || "article");
  const key = generateBibtexKey(publication);

  return `@${type}{${key},\n${fields.join(",\n")}\n}`;
}

export function serializeVaultExport(format, payload) {
  if (format === "bibtex") {
    return {
      contentType: "text/plain; charset=utf-8",
      body: payload.publications.map(publicationToBibtex).join("\n\n"),
      extension: "bib",
    };
  }

  return {
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2),
    extension: "json",
  };
}
