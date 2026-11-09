import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopEdition, EditionUnavailableError, WORKSTATION_FLAVOR, workstationServersState, workstationWindowRequestAllowed,
} from "../src/edition.ts";
import { DEFAULT_SERVERS_STATE } from "../src/servers.ts";

test("only the workstation flavor builds the workstation edition", () => {
  assert.equal(desktopEdition(WORKSTATION_FLAVOR), "workstation");
  for (const flavor of ["", "mac-legacy", "Workstation", "workstation "]) assert.equal(desktopEdition(flavor), "standard");
});

test("the workstation edition forgets other servers saved by an earlier standard install", () => {
  const saved = {
    active: { kind: "address" as const, url: "https://polyth.example" },
    runLocalServer: false,
    linkPorts: { abc: 4401 },
    addresses: [{ url: "https://polyth.example", lastUsedAt: 1 }],
    microphoneServers: ["address:https://polyth.example"],
  };
  assert.deepEqual(workstationServersState(saved as never), DEFAULT_SERVERS_STATE);
});

test("the workstation window reaches this computer's server only", () => {
  const local = "http://127.0.0.1:4455";
  for (const url of [`${local}/api/sessions`, "ws://127.0.0.1:4455/ws", "file:///app/index.html", "data:image/png;base64,AA", "blob:http://127.0.0.1:4455/x", "devtools://devtools/x"]) {
    assert.equal(workstationWindowRequestAllowed(url, local), true, url);
  }
  for (const url of ["https://example.com/pixel.png", "http://127.0.0.1:4456/", "http://localhost:4455/", "wss://127.0.0.1:4455/ws", "https://127.0.0.1:4455/", "ftp://127.0.0.1:4455/", "not a url"]) {
    assert.equal(workstationWindowRequestAllowed(url, local), false, url);
  }
  assert.equal(workstationWindowRequestAllowed(`${local}/`, ""), false);
});

test("an edition refusal carries its code", () => {
  assert.equal(new EditionUnavailableError("Polyth Link").code, "unavailable-in-edition");
});
