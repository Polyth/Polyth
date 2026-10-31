# Docker and Terraform project tools

The **Docker** and **Terraform** packages contribute independent workspace
surfaces and searchable capabilities through `@polyth/web-sdk`. Open them from
the package launcher or capability search; enable or disable them through the
normal package manager. Their manifests own server/web discovery. Neither
package adds a primary workspace mode or changes the host shell.

## Workspace and execution boundary

Both tools operate on a selected repository in a local Project, using its
canonical session checkout when a session is active. The server resolves
Projects and Sessions through `host.forSpace(rc.space)` before filesystem or
CLI access. Unknown, foreign and excluded repository/session IDs fail closed.
Remote Projects and deployments other than `local-trusted` return an
unsupported state; no host-global Docker daemon or Terraform CLI is offered
as a tenant execution boundary. Paired-device routes are default-deny.

Discovery is bounded to 800 directories, 200 matched files and five nested
directory levels below the root. Dependency/build directories and hidden
directories are excluded; symlinks are not followed during discovery.
Selected files are checked again against the canonical repository root.
JSON reads validate the opened regular file and its identity before and after
a bounded read; directory replacement and special files cannot bypass the
repository boundary.
The UI reports when discovery is incomplete. Opening a panel and manually
refreshing perform inspection; there is no background polling.

The Terminal package owns shared server-only helpers at
`@polyth/terminal/project-tools`, DTOs at `@polyth/terminal/tool-types`, and the
browser-safe request/command-review flow at `@polyth/terminal/tool-ui`.
Inspections use argument arrays, capped output and a Polyth-owned process
authority. Package disable closes those authorities. Stderr is consumed but
never returned in panel responses. Read-only agent beta allows discovery and
JSON review but blocks CLI execution.

Actions first request a server-generated command preview. The shared dialog
shows its working directory, exact command and effect. **Run in Terminal**
dispatches once to the existing project/session/repository-scoped Terminal API
and opens that surface. Terminal retains lifecycle, output and canonical event
ownership; the feature packages do not start a second execution system. A failed
dispatch directs the user to inspect Terminal instead of automatically retrying.
Terminal must be enabled to execute an action. No action executes on panel open.

## Docker

The package discovers `compose.yaml`, `compose.yml`, `docker-compose.yaml`,
`docker-compose.yml`, `Dockerfile` and `Dockerfile.*`. The chosen Compose file
is passed explicitly with `-f` and `--project-directory`; implicit parent
configuration discovery and override-file merging are not used.

Docker/Compose CLI availability is separate from Engine availability. Configured
service names come from `compose config --services`. Container inspection uses
`docker ps --all --format '{{json .}}'` filtered by both Compose working-directory
and config-file labels matching the selected file. Containers from other
directories, other Compose files and stacks using multiple config files are
omitted. The DTO contains names, service, image, state, status and published
ports; environment/configuration/inspect payloads are not exposed.

Start (`up --detach`), Stop, Restart, Logs (`--tail 100 --follow`) and Dockerfile
Build actions use the reviewed Terminal handoff. Stop retains containers and
volumes; there is no prune, remove-volumes or daemon-wide action. A build uses
the Dockerfile's directory as context and a project-derived local image tag.
Refresh after a command completes to update the panel.

## Terraform

Folders containing `.tf` or `.tf.json` files appear as configurations. The
presence of a local `.terraform` directory is an initialization hint, not proof
that backend initialization succeeded. `.tfvars`, state and credential contents
are not returned. File links retain Project, Session and repository provenance.

Initialize (`init -input=false`), Check format (`fmt -check`), Validate and
Create plan run through the reviewed Terminal handoff. Planning saves
`polyth.tfplan` inside the selected configuration directory and replaces an
earlier plan at that path. Terraform variables, backend and provider access use
the existing CLI environment; the package adds no credential collection flow.

Refresh exposes saved `tfplan`, `*.tfplan`, `*.tfplan.json` and
`terraform-plan.json` files. On Linux, binary plans are pinned to a verified file descriptor and read with
bounded `show -json`; the Terminal runner retains the descriptor until its CLI
process is proven released, including an uncertain timeout. Other platforms
require an exported JSON plan.
exported JSON plans can be reviewed without an installed CLI. Plan reads are
capped at 4 MiB and summaries at 5,000 resource changes. Supported JSON format
major version is 1. State JSON is not accepted as a plan.

Only resource address/type/action, action counts, Terraform version and the
optional `applyable`/`errored` flags leave the sanitizer. Resource before/after
values, outputs, variables, configuration and state are omitted. Replacement
counts once as **Replace**, rather than twice as Create/Destroy. No-op resources
are omitted; unknown actions remain visible as `other`. A plan with no resource
changes may still change outputs. The panel labels plans as saved snapshots;
it neither proves freshness nor authorizes applying them. Apply and destroy
remain explicit terminal workflows.

Saved binary and exported JSON plans can contain sensitive values. Keep these
artifacts out of version control using the project's ignore/security policy.
The package never automatically exports full plan JSON to a workspace file.

## Owning checks

Use the repository's bounded-check wrapper for the focused tests:
`packages/terminal/test/projectTools.test.ts`,
`packages/docker/test/docker.test.ts` and
`packages/terraform/test/terraform.test.ts`. These exercise workspace isolation,
path checks, exact container scope, process release and plan sanitization with
offline fixtures. Run package containment/discovery checks and `npm run
build:web` for entry or browser import changes. A web/UI check does not establish
live Docker Engine, provider/backend access or native-device behavior.

CLI references: [Docker Compose](https://docs.docker.com/reference/cli/docker/compose/),
[Docker container listing](https://docs.docker.com/reference/cli/docker/container/ls/),
[Terraform show](https://developer.hashicorp.com/terraform/cli/commands/show),
[Terraform JSON format](https://developer.hashicorp.com/terraform/internals/json-format).
