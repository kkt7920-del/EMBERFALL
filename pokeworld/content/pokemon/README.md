# 포켓몬 모델 연결 방법

종 데이터(`species/NNNN_id.json`)에는 도감 번호, 이름, 타입, 능력치, 히트박스,
이동 방식(land / water / underwater / air), 애니메이션 이름이 들어 있습니다.
**3D 모델 파일은 동봉하지 않습니다.** 모델이 없는 종은 다른 동물이나 임의의
크리처로 바꾸지 않고, 히트박스 크기의 분홍·검정 체크 상자와
`MISSING_POKEMON_ASSET #025 Pikachu` 표시로 나옵니다.

본인이 사용할 권리가 있는 파일만 연결하세요. 게임은 인터넷에서 모델을 받아 오지 않고,
다른 게임의 파일을 추출하거나 보호를 우회하는 기능도 없습니다.

## 1. 게임 안에서 가져오기 (이 브라우저에만 저장)

메뉴(Q) → **포켓몬 3D 모델** → 종 옆의 **파일 연결**에서 다음 파일을 함께 고릅니다.

- Bedrock 형식: `*.geo.json` + `*.png`, 선택으로 `*.animation.json` 여러 개와 울음소리(`.ogg/.mp3/.wav`)
- 또는 glTF 바이너리 `*.glb` 1개

파일은 연결하기 전에 파싱해서 검사하고, IndexedDB(`pokeworld-assets`)에 저장합니다.
필드에 있던 같은 종의 포켓몬은 그 자리에서 바로 모델로 바뀝니다. **제거**를 누르면 다시
`MISSING_POKEMON_ASSET` 표시로 돌아갑니다.

## 2. 빌드에 포함하기

파일을 아래 폴더에 넣고 `assets.json`에 연결합니다.

```
content/pokemon/models/pikachu.geo.json
content/pokemon/textures/pikachu.png
content/pokemon/animations/pikachu.animation.json
content/pokemon/cries/pikachu.ogg
```

```json
{
  "format": 1,
  "models": {
    "pikachu": {
      "geometry": "models/pikachu.geo.json",
      "texture": "textures/pikachu.png",
      "animations": ["animations/pikachu.animation.json"],
      "cry": "cries/pikachu.ogg",
      "scale": 1,
      "animationMap": { "idle": "ground_idle", "walk": "ground_walk" }
    },
    "lapras": { "model": "models/lapras.glb" }
  }
}
```

키는 종 JSON의 `modelId`입니다(기본값은 종 id).

## 애니메이션 이름

애니메이션 이름은 끝부분으로 찾습니다. 예를 들어 `animation.pikachu.ground_idle`은 `ground_idle`로 찾습니다.
종 JSON의 `animations`나 `assets.json`의 `animationMap`이 아래 기본값보다 먼저 적용됩니다.

| 상황 | 찾는 이름(앞에서부터) |
| --- | --- |
| 지상 | `ground_idle`, `ground_walk`, `ground_run`, `ground_turn` |
| 물 | `water_idle`, `water_swim`, `water_turn`, `water_dive` |
| 하늘 | `air_idle`, `air_fly`, `air_glide`, `air_turn` |
| 배틀 | `battle_idle`, `physical`, `special`, `recoil`, `faint` |

클립이 없는 상황에서도 모델은 멈춰 있지 않습니다. 뼈(bone) 이름에 `head`, `ear`, `tail`,
`wing`, `leg`, `arm`, `body`가 들어 있으면 그 부위마다 숨쉬기, 꼬리·귀 흔들기,
고개 돌리기 같은 절차적 움직임을 더합니다.

## 형식 메모

- Bedrock 좌표는 16px = 1블록입니다. Blockbench·Cobblemon 방향 그대로 두면 로더가 게임 좌표로 바꿉니다.
- 모델 1개는 스킨드 메시 1개(드로 콜 1회)로 만들어지고, 뼈마다 따로 움직입니다.
- Molang 식(`math.sin(q.anim_time * 180)`, `q.anim_time`, `v.*`)을 지원합니다.
- `tests/fixtures/test-rig/`는 로더를 검사하는 추상적인 상자 리그입니다. 포켓몬 모델이 아니며 게임에 포함되지 않습니다.
