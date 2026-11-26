import assert from "node:assert/strict";
import test from "node:test";
import { invitationCodeFromHash, invitationUrl } from "../src/invitationLink.ts";
import { shareableAddress } from "../src/components/settings/usersModel.ts";

const CODE = `pinv_${"A".repeat(43)}`;

test("an invitation fragment yields only a well-formed code", () => {
  assert.equal(invitationCodeFromHash(`#invite=${CODE}`), CODE);
  assert.equal(invitationCodeFromHash(`invite=${CODE}`), CODE);
  assert.equal(invitationCodeFromHash("#invite=pinv_short"), null);
  assert.equal(invitationCodeFromHash(`#invite=${CODE}<script>`), null);
  assert.equal(invitationCodeFromHash(`#invite=x${CODE}`), null);
  assert.equal(invitationCodeFromHash("#settings=users"), null);
  assert.equal(invitationCodeFromHash(""), null);
});

test("the shared link keeps the server's public address and falls back to this page's", () => {
  assert.equal(
    invitationUrl(`https://team.example/#invite=${CODE}`, "http://127.0.0.1:4400", shareableAddress),
    `https://team.example/#invite=${CODE}`,
  );
  // A server that only knows its loopback origin: the owner's page address is what others can open.
  assert.equal(
    invitationUrl(`http://127.0.0.1:4400/#invite=${CODE}`, "https://team.example", shareableAddress),
    `https://team.example/#invite=${CODE}`,
  );
  // Nothing anyone else can reach: no link, the wizard shows the temporary password.
  assert.equal(invitationUrl(`http://127.0.0.1:4400/#invite=${CODE}`, "http://localhost:4400", shareableAddress), null);
  assert.equal(invitationUrl("https://team.example/#invite=bad", "https://team.example", shareableAddress), null);
  assert.equal(invitationUrl("not a url", "https://team.example", shareableAddress), null);
});
