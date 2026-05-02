#!/usr/bin/env node
/**
 * autopg wrapper — primary CLI bin name post soft-rename.
 *
 * autopg and pgserve route through the same dispatcher. The package
 * stays published as `pgserve` on npm; this wrapper is the new
 * preferred command, with `pgserve` retained as a forever alias.
 *
 * Implementation: delegate to pgserve-wrapper.cjs so dispatch logic
 * stays single-sourced. argv[0]/argv[1] preservation is what matters
 * for the inner module — node already wires argv correctly when
 * require()'d at module load time, and the wrapper inspects
 * process.argv directly.
 */

require('./pgserve-wrapper.cjs');
