/**
 * Isolation module — barrel export
 *
 * Public API for pgserve schema isolation.
 * Consumers should import from this file, not from individual submodules.
 */

export { initCatalog, getCatalogEntry, upsertCatalogEntry } from './catalog.js';
export { provisionSchema } from './provision.js';
export { getConnectionInfo } from './connection-info.js';
export { applyDenyByDefault } from './enforcement.js';
export { validateConnection, isAdminRole } from './admin-hardening.js';
