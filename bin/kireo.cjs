#!/usr/bin/env node

require('../dist/index.cjs')
  .runCli()
  .catch((err) => {
    process.stderr.write(`[kireo] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
