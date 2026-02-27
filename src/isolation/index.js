/**
 * Isolation module — barrel export
 *
 * Public API for pgserve app-schema isolation.
 * Consumers should import from this file, not from individual submodules.
 */

export { normalizeAppId } from './naming.js';
export { initCatalog, getCatalogEntry, upsertCatalogEntry } from './catalog.js';
export { provisionAppSchema } from './provision.js';
export { getAppConnectionInfo } from './connection-info.js';
export { applyDenyByDefault } from './enforcement.js';
export { validateAppConnection, isAdminRole } from './admin-hardening.js';
