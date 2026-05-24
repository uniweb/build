// Canonical uuids for the official Uniweb entity types we export/submit. An
// exported entity's wire `model_uuid` field is set to one of these. Each uuid
// is the type's stable identity across deployments; it never changes across a
// type rename. These are fixed identifiers, not values to invent.

// @uniweb/foundation-schema — a foundation's published schema, as one entity.
export const FOUNDATION_SCHEMA_TYPE_UUID = '019e2336-6d13-717f-a3c4-39b3e8616cd6'

// @uniweb/site-content — a site's content, as one entity.
export const SITE_CONTENT_TYPE_UUID = '019e230f-de00-7069-b3cb-f5922bbd5cca'

// @uniweb/data-schema — one published version of a reusable data schema, as one
// entity. PROVISIONAL: this type is still in flux server-side (the entity
// `package.payload` shape in particular).
export const DATA_SCHEMA_TYPE_UUID = '019e3929-fb7d-742c-8aff-1c26b9abfde7'
