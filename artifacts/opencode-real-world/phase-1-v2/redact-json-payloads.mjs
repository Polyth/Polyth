import { readFile, writeFile } from "node:fs/promises";

const sensitiveKey = (key) =>
  /api.?key|secret|password|authorization|cookie|credential/i.test(key)
  || /(^|[_-])token$/i.test(key);

const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKey(key) ? "[REDACTED]" : redact(item),
    ]),
  );
};

for (const input of process.argv.slice(2)) {
  const parsed = JSON.parse(await readFile(input, "utf8"));
  const output = input.replace(/\.body$/, ".redacted.body");
  await writeFile(output, `${JSON.stringify(redact(parsed))}\n`);
  console.log(output);
}
