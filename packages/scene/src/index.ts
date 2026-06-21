export { buildSceneMap, bakeAutoTiles, scatterGroundDecals, reachabilityCarve, makeRng, wallTagFor, furnishRoom, BUILDING_TEMPLATES, type RoomTemplate } from './cartographer.js';
export { buildCityScene, type CityRequest, type CityDistrictSpec } from './city.js';
export { LlmCityPlanner, normalizeDistricts, CITY_PLANNER_SYSTEM } from './city-planner.js';
export { runProgram, buildSpikeScene, GOLD_PROGRAMS, LlmSceneProgrammer, normalizeProgram, SCENE_PROGRAMMER_SYSTEM, type SceneProgram, type SceneOp } from './scene-program.js';
export { type SceneComposer, FakeSceneComposer, LlmSceneComposer } from './composer.js';
export { loadAssetLibrary, type AssetLibrary, type AssetEntry, type AssetKind } from './asset-library.js';
export * from './catalog.js';
