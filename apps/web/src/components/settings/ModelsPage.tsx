// Providers/Models settings: favorites (star), provider/name/recent sort,
// search. Feeds the composer's model picker through polyth.modelPrefs.
import { Fragment, useState } from "react";
import { filterModels, isFavorite, modelKey, sortModels } from "@polyth/models";
import { setModelSort, toggleModelFavorite, useModelPrefs } from "../../modelPrefs.ts";
import { useStore } from "../../store.ts";
import { providerColor } from "../../format.ts";
import { EmptyState, PageHead, Row, Seg } from "./parts.tsx";

export default function ModelsPage() {
  const models = useStore((s) => s.models);
  const prefs = useModelPrefs();
  const [q, setQ] = useState("");

  const shown = sortModels(filterModels(models, q), prefs);

  return (
    <>
      <PageHead title="Providers & Models" blurb="Star favorites to pin them to the top of the model picker." />
      {models.length === 0 ? (
        <EmptyState title="No models available" body="Check that the backend is running and configured with providers." />
      ) : (
        <>
          <Row label="Sort" hint="Favorites always float first.">
            <Seg value={prefs.sort} options={[["provider", "Provider"], ["name", "Name"], ["recent", "Recent"]]} onChange={setModelSort} />
          </Row>
          <input
            className="set-search"
            value={q}
            placeholder={`Search ${models.length} models…`}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="set-model-list">
            {shown.map((m, n) => {
              const key = modelKey(m);
              const fav = isFavorite(prefs, key);
              const groupBreak = prefs.sort === "provider" && !fav && (n === 0 || shown[n - 1]!.providerID !== m.providerID || isFavorite(prefs, modelKey(shown[n - 1]!)));
              return (
                <Fragment key={key}>
                  {n === 0 && prefs.favorites.length > 0 && fav && <div className="picker-group">Favorites</div>}
                  {groupBreak && <div className="picker-group">{m.providerID}</div>}
                  <div className="set-model-row">
                    <button
                      className={`star-btn ${fav ? "on" : ""}`}
                      title={fav ? "Remove favorite" : "Add favorite"}
                      aria-pressed={fav}
                      onClick={() => toggleModelFavorite(key)}
                    >{fav ? "★" : "☆"}</button>
                    <span className="set-model-dot" style={{ background: providerColor(m.providerID) }} />
                    <span className="set-model-name">{m.name || m.modelID}</span>
                    <span className="set-model-meta mono">{key}</span>
                  </div>
                </Fragment>
              );
            })}
            {shown.length === 0 && <EmptyState title="No matches" />}
          </div>
        </>
      )}
    </>
  );
}
