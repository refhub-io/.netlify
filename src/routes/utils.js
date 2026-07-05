/**
 * Shared constants and helpers used across V2 route modules.
 *
 * These are intentionally independent copies of constants that also exist
 * inline in functions/api-v1.js.  Once the big file is modularised in a
 * future cycle, these will become the single source of truth.
 */

export const VAULT_SELECT =
  "id, user_id, name, description, color, public_slug, category, abstract, created_at, updated_at, visibility";

export const PUBLICATION_FIELDS = [
  "title",
  "authors",
  "year",
  "journal",
  "volume",
  "issue",
  "pages",
  "doi",
  "url",
  "abstract",
  "pdf_url",
  "bibtex_key",
  "publication_type",
  "notes",
  "booktitle",
  "chapter",
  "edition",
  "editor",
  "howpublished",
  "institution",
  "number",
  "organization",
  "publisher",
  "school",
  "series",
  "type",
  "eid",
  "isbn",
  "issn",
  "keywords",
];

export const VAULT_PUBLICATION_SELECT = [
  "id",
  "vault_id",
  "original_publication_id",
  "created_by",
  "version",
  "created_at",
  "updated_at",
  ...PUBLICATION_FIELDS,
].join(", ");

/**
 * Pick only the allowed publication fields from an arbitrary input object.
 * Always sets default arrays for authors / editor / keywords and defaults
 * publication_type to 'article' if absent.
 */
export function pickPublicationFields(input) {
  const row = {};
  for (const field of PUBLICATION_FIELDS) {
    if (input[field] !== undefined) {
      row[field] = input[field];
    }
  }
  if (!row.authors) row.authors = [];
  if (!row.editor) row.editor = [];
  if (!row.keywords) row.keywords = [];
  if (!row.publication_type) row.publication_type = "article";
  return row;
}

/**
 * Validate that all provided tag IDs belong to the given vault.
 * Throws an error with code 'invalid_tag_ids' if any are missing.
 * Returns the original tagIds array unchanged on success.
 */
export async function validateVaultTagIds(supabase, vaultId, tagIds) {
  if (!tagIds || tagIds.length === 0) return [];

  const { data, error } = await supabase
    .from("tags")
    .select("id")
    .eq("vault_id", vaultId)
    .in("id", tagIds);

  if (error) throw error;

  const found = new Set((data || []).map((t) => t.id));
  const missing = tagIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    const err = new Error(`Unknown vault tag ids: ${missing.join(", ")}`);
    err.code = "invalid_tag_ids";
    throw err;
  }

  return tagIds;
}

/**
 * Enriches vault_publications rows with drive_pdf_url — the Google-Drive-
 * stored copy of the PDF (publication_pdf_assets.stored_pdf_url) — kept
 * separate from pdf_url (the publisher-hosted link entered/imported as
 * bibliographic metadata). A Drive file is a storage asset, not metadata,
 * and publication_pdf_assets is keyed per uploading user, so folding it
 * into the shared pdf_url column would leak one user's private Drive link
 * into a field every vault collaborator sees. This mirrors the same
 * vault-then-canonical-publication lookup and field name the RefHub
 * frontend uses when it queries publication_pdf_assets directly.
 */
export async function attachDrivePdfUrls(supabase, items) {
  if (!items || items.length === 0) return items ?? [];

  const vaultPublicationIds = items.map((item) => item.id).filter(Boolean);
  const originalPublicationIds = [
    ...new Set(items.map((item) => item.original_publication_id).filter(Boolean)),
  ];

  const [vaultAssetsResult, publicationAssetsResult] = await Promise.all([
    vaultPublicationIds.length > 0
      ? supabase
          .from("publication_pdf_assets")
          .select("vault_publication_id, stored_pdf_url")
          .in("vault_publication_id", vaultPublicationIds)
          .eq("storage_provider", "google_drive")
          .eq("status", "stored")
      : Promise.resolve({ data: [], error: null }),
    originalPublicationIds.length > 0
      ? supabase
          .from("publication_pdf_assets")
          .select("publication_id, stored_pdf_url")
          .in("publication_id", originalPublicationIds)
          .is("vault_publication_id", null)
          .eq("storage_provider", "google_drive")
          .eq("status", "stored")
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (vaultAssetsResult.error) throw vaultAssetsResult.error;
  if (publicationAssetsResult.error) throw publicationAssetsResult.error;

  const byPublicationId = new Map();
  for (const row of publicationAssetsResult.data || []) {
    if (row.publication_id) byPublicationId.set(row.publication_id, row.stored_pdf_url ?? null);
  }

  const byVaultPublicationId = new Map();
  for (const row of vaultAssetsResult.data || []) {
    if (row.vault_publication_id) byVaultPublicationId.set(row.vault_publication_id, row.stored_pdf_url ?? null);
  }

  return items.map((item) => ({
    ...item,
    drive_pdf_url:
      byVaultPublicationId.get(item.id) ??
      (item.original_publication_id ? byPublicationId.get(item.original_publication_id) : null) ??
      null,
  }));
}

/**
 * Touch vaults.updated_at so the existing DB trigger (update_vaults_updated_at)
 * fires and stamps now() — making all item/tag/relation writes reflect on
 * the vault's modification timestamp.
 *
 * We write updated_at explicitly; the BEFORE UPDATE trigger overwrites it
 * with now(), which is fine — the important thing is that the trigger fires.
 *
 * Errors are logged but do NOT propagate — a failure here must never abort
 * the parent operation.
 */
export async function touchVaultUpdatedAt(supabase, vaultId) {
  const { error } = await supabase
    .from("vaults")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", vaultId);

  if (error) {
    console.error("touchVaultUpdatedAt failed", { vaultId, code: error.code, message: error.message });
  }
}
