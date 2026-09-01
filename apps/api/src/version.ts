/**
 * The application's version, in one place.
 *
 * It appears in three: `package.json`, the MCP server's handshake, and the
 * version resource written into the Windows executable. Two of those are read
 * from `package.json` at build time; this constant is what the running code
 * reports, and a test asserts the two agree so they cannot drift apart
 * unnoticed.
 *
 * Not the same thing as a source plugin's `version`, which describes that one
 * adapter and moves independently.
 */
export const APP_VERSION = '0.0.4';
