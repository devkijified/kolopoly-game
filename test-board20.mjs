// The 20-space board is retired. corners28 is the live board, and
// test-board28.mjs is the suite that covers it: geometry, Owambe,
// missed turns, Sapa, reconnects, and migration of 40, 28 and 20
// space snapshots onto corners28. This file stays so an old command
// still exits clean instead of asserting the old geometry.
console.log('board20 retired: the live board is corners28. Run node test-board28.mjs');
process.exit(0);
