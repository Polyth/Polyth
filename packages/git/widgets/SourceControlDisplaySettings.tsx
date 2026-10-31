// Account-wide Source Control display defaults. They sync through the
// `package.git.preferences` registration; a repository keeps any diff layout
// it chose in the view itself, everything else follows these values.
import { ResetLink, Row, Section, Seg, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { GitFileEntry } from "@polyth/session/web-api";
import { ChangeSection, fileStatKey } from "./ChangeList.tsx";
import type { DiffLineStats } from "./PendingChangesBar.tsx";
import { GIT_PREFS_DEFAULTS, setGitPrefs, useGitPrefs, type GitPrefs } from "./gitPrefs.ts";

type PrefKey = keyof Omit<GitPrefs, "reviewScope">;

const CHANGES: readonly PrefKey[] = ["changesView", "lineStats", "density"];
const DIFFS: readonly PrefKey[] = ["layout", "wrap", "ignoreWhitespace"];
const HISTORY: readonly PrefKey[] = ["logGraph", "dateStyle"];

const SAMPLE: ReadonlyArray<GitFileEntry & DiffLineStats> = [
  { path: "src/settings/SettingsPage.tsx", status: "modified", staged: false, additions: 48, deletions: 31 },
  { path: "src/settings/settings.css", status: "modified", staged: false, additions: 22, deletions: 4 },
  { path: "src/settings/Preview.tsx", status: "untracked", staged: false, additions: 64, deletions: 0 },
  { path: "README.md", status: "modified", staged: false, additions: 3, deletions: 1 },
];
const SAMPLE_STATS: Record<string, DiffLineStats> = Object.fromEntries(
  SAMPLE.map((file) => [fileStatKey(file), { additions: file.additions, deletions: file.deletions }]),
);
const NO_CLOSED = new Set<string>();
const noop = () => {};

function resetFor(prefs: GitPrefs, keys: readonly PrefKey[]) {
  const atDefault = keys.every((key) => prefs[key] === GIT_PREFS_DEFAULTS[key]);
  return (
    <ResetLink
      disabled={atDefault}
      onClick={() => setGitPrefs(Object.fromEntries(keys.map((key) => [key, GIT_PREFS_DEFAULTS[key]])) as Partial<GitPrefs>)}
    />
  );
}

/** The real change list, rendered inert from sample files, so each choice
 *  shows what it does before the person opens Source control. */
function ChangeListPreview({ prefs }: { prefs: GitPrefs }) {
  return (
    <figure className="git-settings-preview" aria-label={tr("gitsettings.displayPreview")}>
      <div className="git-page git-settings-preview-page" data-density={prefs.density} inert aria-hidden="true">
        <ChangeSection
          group={{ id: "changes", title: tr("gitview.tabChanges"), files: SAMPLE.map(({ path, status, staged }) => ({ path, status, staged })) }}
          view={prefs.changesView}
          closed={NO_CLOSED}
          onToggle={noop}
          selected={null}
          busy={false}
          fileStats={SAMPLE_STATS}
          lineStats={prefs.lineStats}
          onOpen={noop}
          onStage={noop}
          onDiscard={noop}
        />
      </div>
    </figure>
  );
}

export default function SourceControlDisplaySettings() {
  const prefs = useGitPrefs();
  return (
    <>
      <Section title={tr("gitsettings.displayChanges")} hint={tr("gitsettings.displayChangesHint")} itemId="git.display" action={resetFor(prefs, CHANGES)}>
        <ChangeListPreview prefs={prefs} />
        <Row label={tr("gitview.showChangesAs")} hint={tr("gitview.changesViewHint")} itemId="git.changesView">
          <Seg label={tr("gitview.showChangesAs")} value={prefs.changesView} options={[["tree", tr("gitview.viewAsTree")], ["flat", tr("gitview.viewAsList")]]} onChange={(changesView) => setGitPrefs({ changesView })} />
        </Row>
        <Row label={tr("gitview.lineStats")} hint={tr("gitview.lineStatsHint")} itemId="git.lineStats">
          <Seg label={tr("gitview.lineStats")} value={prefs.lineStats} options={[["numbers", tr("gitview.lineStatsNumbers")], ["bar", tr("gitview.lineStatsBar")], ["hidden", tr("gitview.lineStatsHidden")]]} onChange={(lineStats) => setGitPrefs({ lineStats })} />
        </Row>
        <Row label={tr("gitview.density")} hint={tr("gitview.densityHint")} itemId="git.density">
          <Seg label={tr("gitview.density")} value={prefs.density} options={[["compact", tr("gitview.densityCompact")], ["comfortable", tr("gitview.densityComfortable")]]} onChange={(density) => setGitPrefs({ density })} />
        </Row>
      </Section>
      <Section title={tr("gitsettings.displayDiffs")} hint={tr("gitsettings.displayDiffsHint")} action={resetFor(prefs, DIFFS)}>
        <Row label={tr("gitview.defaultDiffLayout")} hint={tr("gitview.defaultDiffLayoutHint")} itemId="git.diffLayout">
          <Seg label={tr("gitview.defaultDiffLayout")} value={prefs.layout} options={[["unified", tr("gitview.unified")], ["split", tr("gitview.split")]]} onChange={(layout) => setGitPrefs({ layout })} />
        </Row>
        <Row label={tr("gitview.wrapLines")} hint={tr("gitsettings.wrapLinesHint")} itemId="git.wrap">
          <Toggle on={prefs.wrap} onChange={(wrap) => setGitPrefs({ wrap })} label={tr("gitview.wrapLines")} />
        </Row>
        <Row label={tr("gitview.ignoreWhitespace")} hint={tr("gitsettings.ignoreWhitespaceHint")} itemId="git.ignoreWhitespace">
          <Toggle on={prefs.ignoreWhitespace} onChange={(ignoreWhitespace) => setGitPrefs({ ignoreWhitespace })} label={tr("gitview.ignoreWhitespace")} />
        </Row>
      </Section>
      <Section title={tr("gitsettings.displayHistory")} hint={tr("gitsettings.displayHistoryHint")} action={resetFor(prefs, HISTORY)}>
        <Row label={tr("gitview.showGraph")} hint={tr("gitview.showGraphHint")} itemId="git.logGraph">
          <Toggle on={prefs.logGraph} onChange={(logGraph) => setGitPrefs({ logGraph })} label={tr("gitview.showGraph")} />
        </Row>
        <Row label={tr("gitview.dates")} hint={tr("gitview.datesHint")} itemId="git.dateStyle">
          <Seg label={tr("gitview.dates")} value={prefs.dateStyle} options={[["relative", tr("gitview.datesRelative")], ["absolute", tr("gitview.datesAbsolute")]]} onChange={(dateStyle) => setGitPrefs({ dateStyle })} />
        </Row>
      </Section>
    </>
  );
}
