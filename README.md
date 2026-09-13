# EMBERFALL

복구용 저장소입니다. 업로드된 `emberfall-save` 세이브 구조를 기준으로 원본과 호환 가능한 웹 게임 구조를 재설계합니다.

## 바로 실행

- 개발/최신판: https://raw.githack.com/kkt7920-del/EMBERFALL/main/index.html
- 고정 복원판 v0.1: https://rawcdn.githack.com/kkt7920-del/EMBERFALL/852f2f390df06c240112d5c417e734a39cba7c72/index.html

`raw.githack.com`은 GitHub 저장소의 정적 HTML/CSS/JS를 브라우저에서 실행할 수 있도록 제공하는 개발용 프록시입니다. 최신판은 GitHub 변경 사항이 몇 분 뒤 반영될 수 있습니다.

## 현재 구현

- 기존 세이브 JSON 가져오기/내보내기 호환
- 버서커 장비/속성/변형 체계 복원
- 인벤토리/장착/스킬 성장 구조 복원
- 스킬 체험장(MVP)
- 주무기 속성 + 스킬 A/B 폼 + 보조무기 변형 호환성 설계

## 복원 원칙

원본 JSON에서 확인되는 필드는 가능한 한 보존합니다. 원본 소스코드가 없어 전투 공식, 스킬 모션, 몬스터 AI 등 세이브만으로 확인할 수 없는 부분은 복원판 규칙으로 별도 설계합니다.
