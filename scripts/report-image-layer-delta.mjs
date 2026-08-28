import { appendFile } from 'node:fs/promises';

const [, , repositoryArg, currentReference, previousReference, budgetArg] = process.argv;

if (!repositoryArg || !currentReference || !previousReference || !budgetArg) {
  console.error(
    'Usage: node scripts/report-image-layer-delta.mjs <dockerhub-repository> <current-ref> <previous-ref> <budget-mib>',
  );
  process.exit(2);
}

const repository = repositoryArg.replace(/^(?:docker\.io|registry-1\.docker\.io)\//, '');
const budgetMiB = Number(budgetArg);
if (!/^[a-z0-9._/-]+$/.test(repository) || !Number.isFinite(budgetMiB) || budgetMiB <= 0) {
  console.error('Invalid Docker Hub repository or layer budget.');
  process.exit(2);
}

const manifestAccept = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const registryBase = `https://registry-1.docker.io/v2/${repository}`;
const tokenResponse = await fetch(
  `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
);
if (!tokenResponse.ok) {
  throw new Error(`Docker Hub token request failed: HTTP ${tokenResponse.status}`);
}
const { token } = await tokenResponse.json();

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readManifest(reference, attempts = 1) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`${registryBase}/manifests/${reference}`, {
      headers: { Accept: manifestAccept, Authorization: `Bearer ${token}` },
    });
    if (response.ok) return response.json();
    if (response.status !== 404 || attempt === attempts) {
      if (response.status === 404) return undefined;
      throw new Error(`Manifest ${reference} request failed: HTTP ${response.status}`);
    }
    await wait(5_000);
  }
  return undefined;
}

async function readPlatformLayers(reference, architecture, attempts) {
  const index = await readManifest(reference, attempts);
  if (!index) return undefined;
  if (Array.isArray(index.layers)) return index.layers;

  const descriptor = index.manifests?.find(
    (candidate) =>
      candidate.platform?.os === 'linux' && candidate.platform?.architecture === architecture,
  );
  if (!descriptor) return undefined;
  const manifest = await readManifest(descriptor.digest, attempts);
  return manifest?.layers;
}

const byteFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const toMiB = (bytes) => bytes / 1024 / 1024;
const rows = [];

for (const architecture of ['amd64', 'arm64']) {
  const [currentLayers, previousLayers] = await Promise.all([
    readPlatformLayers(currentReference, architecture, 6),
    readPlatformLayers(previousReference, architecture, 1),
  ]);
  if (!currentLayers || !previousLayers) continue;

  const previousDigests = new Set(previousLayers.map((layer) => layer.digest));
  const totalBytes = currentLayers.reduce((sum, layer) => sum + layer.size, 0);
  const newLayers = currentLayers.filter((layer) => !previousDigests.has(layer.digest));
  const newBytes = newLayers.reduce((sum, layer) => sum + layer.size, 0);
  const reusedPercent = totalBytes === 0 ? 100 : ((totalBytes - newBytes) / totalBytes) * 100;
  rows.push({ architecture, newBytes, newLayerCount: newLayers.length, reusedPercent, totalBytes });
}

if (rows.length === 0) {
  console.log(
    `::warning title=Image layer delta unavailable::Could not compare ${repository}:${previousReference} with ${currentReference}.`,
  );
  process.exit(0);
}

const budgetBytes = budgetMiB * 1024 * 1024;
const summaryLines = [
  '### Runtime image layer delta',
  '',
  `Compared \`${repository}:${previousReference}\` → \`${repository}:${currentReference}\` with a ${budgetMiB} MiB budget.`,
  '',
  '| Platform | New layers | New download | Full image | Reused |',
  '| --- | ---: | ---: | ---: | ---: |',
];

for (const row of rows) {
  const newMiB = toMiB(row.newBytes);
  const totalMiB = toMiB(row.totalBytes);
  const result = `linux/${row.architecture}: ${row.newLayerCount} new layers, ${byteFormat.format(newMiB)} MiB download, ${byteFormat.format(row.reusedPercent)}% reused`;
  console.log(result);
  summaryLines.push(
    `| linux/${row.architecture} | ${row.newLayerCount} | ${byteFormat.format(newMiB)} MiB | ${byteFormat.format(totalMiB)} MiB | ${byteFormat.format(row.reusedPercent)}% |`,
  );
  if (row.newBytes > budgetBytes) {
    console.log(
      `::warning title=Runtime image layer budget exceeded::${result}; budget is ${budgetMiB} MiB.`,
    );
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summaryLines.join('\n')}\n`);
}
