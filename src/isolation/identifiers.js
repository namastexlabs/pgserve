/**
 * Identifier validation helpers
 *
 * PostgreSQL identifiers used as schema/role names are interpolated directly
 * into SQL via sql.unsafe(). To prevent SQL injection, all identifiers must
 * match a strict allowlist pattern before any SQL is executed.
 *
 * Allowed pattern: starts with a letter or underscore, followed by letters,
 * digits, or underscores. This matches safe, unquoted PostgreSQL identifiers.
 */

const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate that a string is a safe SQL identifier.
 * Throws if the value does not match the allowed pattern.
 *
 * @param {string} value - The identifier to validate
 * @param {string} [label='identifier'] - Label used in the error message
 * @throws {Error} If the value contains characters outside the allowed set
 */
export function validateIdentifier(value, label = 'identifier') {
  if (!SAFE_IDENTIFIER_RE.test(value)) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(value)}. ` +
        'Must start with a letter or underscore and contain only letters, digits, or underscores.',
    );
  }
}
