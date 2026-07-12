#!/usr/bin/env node

require('../dist/index.cjs')
  .startServer()
  .catch((err) => {
    process.stderr.write(`[kireo-mcp] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
