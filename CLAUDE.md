# Agent-ReqAnalyzer

## Known issues

- **Corrupted `node_modules/zod` install**: `zod@^4.6.5`'s `index.js` imports from
  `./v4/classic/external.js`, but a partial/corrupted install can end up missing the
  entire `v4/` subfolder (only `src`, `mini`, `compile.*`, `locales` present), causing:
  `Cannot find module '...\node_modules\zod\v4\classic\external.js'`.
  Plain `npm install` won't fix it if `package-lock.json` already considers zod
  "installed" — you must force a reinstall of just that package:
  ```
  rm -rf node_modules/zod && npm install zod@^4.6.5
  ```

- **`picocolors` force-enables color on Windows**: `picocolors` treats
  `process.platform === "win32"` as sufficient to enable ANSI color, regardless of
  whether stdout is a TTY. This broke `test/run-offline.mjs`'s plain-text assertions
  when run on Windows, since the CLI output it captures via `execFileSync` came back
  with ANSI escape codes. Fixed by setting `NO_COLOR: '1'` in the test's child-process
  env (see `test/run-offline.mjs`).
