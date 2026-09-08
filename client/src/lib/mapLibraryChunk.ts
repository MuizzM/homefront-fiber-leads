// The lazy half of the map library load. Nothing imports this statically -
// mapLibrary.ts reaches it through `import()`, which is what keeps MapLibre
// (~250KB gz) and its stylesheet out of every session that never opens a map.
//
// The CSS import lives HERE rather than in index.css for the same reason: Vite
// attaches a dynamic chunk's stylesheet to that chunk, so it is fetched with
// the library and not before.
import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

// Vite must bundle the worker's shared-module imports, not copy it as a raw
// asset. Publish a mutable facade for legacy callers assigning accessToken.
maplibregl.setWorkerUrl(workerUrl);
export default { ...maplibregl, accessToken: "" };
