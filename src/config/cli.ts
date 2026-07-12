import type { PartialConfig } from './schema.js';

/** Long-arg only: --key=value or --key value */
export const readCli = (argv: string[] = process.argv.slice(2)): PartialConfig => {
  const cfg: PartialConfig = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok || !tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    let key: string;
    let val: string | undefined;
    if (eq > 0) {
      key = tok.slice(2, eq);
      val = tok.slice(eq + 1);
    } else {
      key = tok.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        val = next;
        i++;
      } else {
        val = 'true';
      }
    }
    switch (key) {
      case 'api-key':
        if (val) cfg.apiKey = val;
        break;
      case 'api-url':
        if (val) cfg.apiUrl = val;
        break;
      // `--timeout` is the documented flag; `--timeout-ms` is kept as an alias.
      case 'timeout':
      case 'timeout-ms':
        if (val) {
          const n = Number.parseInt(val, 10);
          if (Number.isFinite(n)) cfg.requestTimeoutMs = n;
        }
        break;
      case 'no-telemetry':
        cfg.telemetryEnabled = false;
        break;
      case 'log-level':
        if (val) cfg.logLevel = val as NonNullable<PartialConfig['logLevel']>;
        break;
      case 'namespace':
        if (val) cfg.defaultNamespace = val;
        break;
    }
  }
  return cfg;
};
