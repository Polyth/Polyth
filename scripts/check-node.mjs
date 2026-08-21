const required = [22, 18, 0];
const current = process.versions.node.split(".").map(Number);
const supported =
  current[0] > required[0]
  || (current[0] === required[0] && current[1] > required[1])
  || (current[0] === required[0] && current[1] === required[1] && current[2] >= required[2]);

if (!supported) {
  console.error(
    `Polyth requires Node.js >=22.18.0 (current: ${process.versions.node}). `
    + "Install a supported release or run `nvm use` before installing, building, testing, or starting.",
  );
  process.exit(1);
}
