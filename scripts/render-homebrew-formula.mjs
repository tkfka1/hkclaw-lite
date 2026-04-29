import fs from 'node:fs';

import { renderHomebrewFormula } from './release-utils.mjs';

function readArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && process.argv[1].endsWith('render-homebrew-formula.mjs')) {
  const version = readArg('version') || process.env.RELEASE_VERSION;
  const sha256 = readArg('sha256') || process.env.HOMEBREW_TARBALL_SHA256;
  const tarballUrl = readArg('url') || process.env.HOMEBREW_TARBALL_URL;
  const outPath = readArg('out');
  const formula = renderHomebrewFormula({ version, sha256, tarballUrl });
  if (outPath) {
    fs.writeFileSync(outPath, formula);
  } else {
    process.stdout.write(formula);
  }
}
