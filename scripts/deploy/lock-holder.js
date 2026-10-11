'use strict';
// flock owns the lock while this child waits for the controller's stdin.
// EOF also releases it if the controller crashes. No long-lived daemon.
process.stdin.resume();
process.stdin.once('end', () => process.exit(0));
process.stdout.write('LOCKED\n');
