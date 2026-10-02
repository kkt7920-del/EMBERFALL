# Test rig model (test fixture only)

`test_rig.geo.json`, `test_rig.animation.json` and `test_rig.png` are an
original, deliberately abstract box rig (body, head, two ears, tail, four
legs) made for this project's tests. It is **not a Pokémon** and is never
bundled into the game.

The e2e suite `tests/e2e/models.mjs` imports these files through the in-game
"3D 모델" panel into the test browser's IndexedDB to check that:

- the Bedrock geometry/texture/animation loader builds a skinned model,
- the species' MISSING_POKEMON_ASSET marker is replaced by the model,
- bones animate separately (head, ears, tail and legs move independently),
- removing the import brings the MISSING marker back.
