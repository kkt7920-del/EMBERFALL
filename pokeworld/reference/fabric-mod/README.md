# PokeWorld

> 참고용(REFERENCE ADAPTER) 프로젝트입니다. 실제 배포판은 상위 디렉터리의 웹 게임입니다.
> 이 모듈은 시스템 설계와 데이터 구조 참고용으로 유지합니다.

Cobblemon 기반 오픈월드 탐험 모드 (Minecraft Java 1.21.1 / Fabric / Kotlin).

탐험 · 포획 · 배틀 · 육성 · 진화 · 유적 · 전설 이벤트 · 채광 · 제작 · 육상/해상/해저/공중 이동이 핵심입니다.
포켓몬 허기, 농사, 작업 배치, 생산, 노동, 피로, 목욕 등 Palworld식 시스템은 어떤 단계에서도 구현하지 않습니다
(바닐라 마인크래프트 농사는 그대로 둡니다).

## 구조

```
pokeworld/
  core/     Minecraft에 의존하지 않는 순수 Kotlin. 모든 게임 규칙 + 단위 테스트
  fabric/   Fabric Loom 모드 프로젝트. core 소스를 함께 컴파일해 모드 jar를 만든다
```

`core/src/main/kotlin/com/pokeworld/`

| 패키지 | 내용 |
| --- | --- |
| `core` | `GameDefinition`, `GameRegistry`, `PokeWorldRegistries`, 설정(`PokeWorldConfig`, 로더), `ContentPack`, `PokeWorldEngine`, `PlayerProgress` |
| `integration` | `ModEnvironment`, `ModVersion`, Cobblemon/Mega Showdown 감지 |
| `region`, `biome` | 지역, 기후, 지역 연결(뱃지/퀘스트 조건), 바이옴 |
| `spawn` | 데이터 기반 스폰 정의와 가중치 선택 |
| `pokemon` | `PokemonAdapter`. 포켓몬 자체는 전부 Cobblemon이 담당 |
| `battle` | 배틀 기믹(메가/Z/다이맥스/거다이맥스/테라스탈), 배틀당 사용 제한 |
| `mount`, `vehicle` | 라이딩 능력치, 탈것, 비행기 부품/단계 |
| `ocean`, `air` | 바다/하늘 층(zone) 정의 |
| `mining`, `crafting`, `structure`, `quest`, `legendary` | 광석, 레시피, 구조물, 퀘스트, 전설 이벤트 조건 |

`fabric/src/main/kotlin/com/pokeworld/`: `PokeWorldMod`(공통 엔트리포인트), `client/PokeWorldClient`(클라이언트 전용), `integration/FabricModEnvironment`.

## 진행 상황

| 단계 | 상태 |
| --- | --- |
| 원본 `PokeWorldCore.kt` 분리 | 완료 |
| PHASE 1: Fabric 프로젝트, 레지스트리, 설정, Cobblemon 감지, Mega Showdown 선택 감지 | 코드 작성 완료. `core` 컴파일/테스트 통과, `fabric` 모듈은 아래 "빌드" 참고 |
| PHASE 2 ~ 15 | 미착수 |

바다/하늘 층의 진입 조건과 진행(해변 → … → 고대 해저유적, 저공 → … → 하늘섬), 비행기 제작 단계
(목재 글라이더 → 소형 프로펠러기 → 경비행기 → 수상비행기 → 고속 탐사기)는 지금은 정의(enum/데이터 클래스)만 있고,
실제 시스템은 각각 PHASE 6, 8에서 구현합니다.

## 설정

첫 실행 시 `config/pokeworld/server.json`이 생성됩니다.

```json
{
  "configVersion": 1,
  "features": { "exploration": true, "megaEvolution": true, "...": true },
  "battle": { "majorGimmicksPerPlayerPerBattle": 1 },
  "integrations": { "megaShowdown": true }
}
```

- `battle.majorGimmicksPerPlayerPerBattle`: 플레이어가 배틀 하나에서 쓸 수 있는 주요 기믹 수. 기본 1, 0이면 끔.
- 파일이 깨져 있으면 덮어쓰지 않고 기본값으로 실행하며 로그에 경고를 남깁니다.
- 없는 키는 기본값, 모르는 키는 무시합니다.

## 의존성

- 필수: Fabric Loader 0.17.3, Fabric API 0.116.7+1.21.1 (0.116.17+1.21.1도 호환), Fabric Language Kotlin 1.13.7+kotlin.2.2.21, **Cobblemon ≥ 1.8.1** (`fabric.mod.json`의 `depends`)
- 선택: Mega Showdown (`mega_showdown`). 없으면 배틀 기믹만 꺼진 채 정상 실행됩니다.
  PHASE 1은 감지만 하며, 실제 연동은 PHASE 14에서 공개 API로만 구현합니다.

## 빌드

```bash
# core만 (Minecraft 불필요): 컴파일 + 단위 테스트
./gradlew -Ppokeworld.coreOnly=true :core:build

# 모드 jar (maven.fabricmc.net, Mojang 서버 접근 필요)
./gradlew build                # -> fabric/build/libs/pokeworld-<version>.jar
./gradlew :fabric:runServer    # 전용 서버 기동 확인
./gradlew :fabric:runClient    # 클라이언트 기동 확인
```

의존성 버전은 Mega Showdown 개발 저장소의 호환 기준으로 확인된 값입니다. Loom 플러그인 버전(`1.11-SNAPSHOT`)만 미확인입니다.
