// The lazy half of the map library load. Nothing imports this statically -
// mapLibrary.ts reaches it through `import()`, which is what keeps MapLibre
// (~250KB gz) and its stylesheet out of every session that never opens a map.
//
// The CSS import lives HERE rather than in index.css for the same reason: Vite
// attaches a dynamic chunk's stylesheet to that chunk, so it is fetched with
// the library and not before.
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";

export default maplibregl;
