import assert from "node:assert/strict";
import test from "node:test";
import {
  checkI18n,
  discoverShellI18nPackages,
  renderLocaleCatalog,
  renderPackageCatalogs,
} from "../generateI18n.ts";

test("committed i18n catalogs match the generator output", async () => {
  assert.deepEqual(
    await checkI18n(),
    [],
    "run `npm run i18n:generate` and commit the result",
  );
});

test("removing a package drops every trace from the generated catalogs", async () => {
  const packages = await discoverShellI18nPackages();
  assert.ok(packages.length > 1, "several packages are discovered");
  // Pick the discovered package and a non-English locale from discovery rather
  // than naming one, so the check holds whether or not any given package exists.
  const removed = packages.find((pkg) => pkg.locales.includes("uk"));
  assert.ok(removed, "a package ships a Ukrainian catalog");
  const withoutRemoved = packages.filter((pkg) => pkg.id !== removed.id);
  const alias = `p_${removed.id.replaceAll(/[^A-Za-z0-9]/g, "_")}`;

  const aggregate = renderPackageCatalogs(withoutRemoved);
  const ukrainian = renderLocaleCatalog("uk", withoutRemoved);
  for (const [name, source] of [
    ["packageCatalogs", aggregate],
    ["uk", ukrainian],
  ] as const) {
    assert.equal(source.includes(`${removed.packageName}/i18n`), false,
      `${name} still imports ${removed.packageName}`);
    assert.equal(new RegExp(`\\b${alias}\\b`).test(source), false, `${name} still aliases ${removed.id}`);
  }
  const survivor = withoutRemoved.find((pkg) => pkg.locales.includes("uk"));
  assert.ok(survivor, "another package ships a Ukrainian catalog");
  assert.ok(aggregate.includes(`${survivor.packageName}/i18n`), "other packages must survive the removal");
});
