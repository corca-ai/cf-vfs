# POSIX 경로 해석 수정 — 2026-10-08

직접 VFS 및 promise-FS에서 symlink를 해석한 뒤 `.`과 `..`를 적용한다.
저장 구조를 바꾸거나 파일 핸들을 추가하지 않는다.

## 의미론

같은 Linux 파일 시스템에 같은 연산을 실행하고 반환값, 오류 코드, 연산 뒤
파일/링크 내용을 비교했다. 기존 28개는 **21 → 22개 일치**한다. 추가한
5개 경계 사례까지 포함하면 같은 33개 집합에서 **21/33 → 27/33**이다.

고친 사례는 symlink 뒤 `..`, 파일 뒤 `.`·`..`의 ENOTDIR, 없는 디렉터리
뒤 `..`의 ENOENT, link target 내부의 `..`, `lstat(link/.)`이다. 캐시가
먼저 lexical 경로의 다른 파일을 읽은 상태에서도 올바른 파일을 선택한다.
추가 회귀 검사는 되돌아가기 전에 거친 디렉터리의 검색 권한과 스트리밍
쓰기 중 symlink 교체를 검증한다. symlink hop 제한은 재귀적인 dot 해석
사이에서도 공유한다. 실제 workerd SQLite에서도 같은 동작을 확인한다.

남겨둔 것은 시간 정보의 3개 차이와 open API의 3개 차이다. ctime을
mtime과 분리해서 영속화하지 않은 상태에서 mtime만 바꾸면 ctime 의미가
깨진다. 부모 디렉터리 시간 갱신도 namespace mutation과 추가 쓰기 비용을
함께 다뤄야 한다. 열린 핸들은 inode 공유 상태와 unlink 후 수명 설계가
필요하다. 이번에는 이 범위를 확장하지 않았다.

일부 shell operand는 VFS 호출 전에 lexical 정규화를 하므로 shell 전체의
동일 동작까지 고쳤다고 주장하지 않는다. 큰 opaque 쓰기는 기존 canonical
예약이 dot 경로의 traversal guard를 저장할 수 없어 ENOTSUP로 거부한다.
Inline 쓰기와 opaque 읽기는 새 경로 해석을 사용한다.

## 평가 방법

Linux neverland, ext4, Node 24.18.0을 사용했다. 일반 작업은 크기별 새
파일 시스템, 준비/검증을 타이머 밖에 두고 warmup 후 반복했다. 각
코드를 별도 프로세스에서 실행하고 before/after 순서를 AB/BA로 번갈아
비교하도록 `POSIX_COMPARE_LIBRARY`를 추가했다. SQL·결과 행·반환 BLOB
바이트도 기록한다.
workerd에서는 기존 SQL/과금 행 성능 guards를 유지한다.

같은 프로세스에 두 모듈을 적재한 초기 비교는 폐기했다. 동일한 소스
복사본끼리의 A/A 비교에서도 32 KiB 읽기가 37.5% 느려지는 편향이 있었다.
짧은 append 반복도 편차가 커서, 별도 프로세스의 A/A 대조군과 충분히
반복한 steady-state 측정을 함께 보관한다. 기존 짧은 측정도 진단 자료로
남기며, 안정 상태 수치가 시작 비용까지 보장한다는 뜻은 아니다.

초기 구현은 일반 경로에서도 탐색 context 객체를 생성했다. 이를 제거하고
정규식을 재사용하며, 일반 경로에는 기존 normalizer와 알려진 no-symlink
point lookup을 사용한다. 성능 결과와 검증 로그는
[평가 디렉터리](posix-path-fix)에 보관한다.

## 최종 구현의 성능

9쌍의 독립 프로세스 비교, 각 프로세스에서 warmup 1회 후 측정 1회다.
아래는 반복 전체 시간의 중앙값이며, 양수는 느려졌다는 뜻이다.

| 연산 | 파일 바이트 | 반복 | 수정 전 ms | 수정 후 ms | 변화 |
| --- | ---: | ---: | ---: | ---: | ---: |
| read-small | 0 | 3000 | 59.688 | 68.633 | +15.0% |
| read-small | 80 | 3000 | 89.877 | 90.610 | +0.8% |
| read-small | 8192 | 3000 | 119.839 | 109.322 | -8.8% |
| read-small | 32768 | 3000 | 168.631 | 182.432 | +8.2% |
| create | 0 | 3000 | 186.742 | 192.140 | +2.9% |
| create | 80 | 3000 | 226.838 | 232.062 | +2.3% |
| create | 8192 | 3000 | 250.960 | 252.972 | +0.8% |
| overwrite | 0 | 3000 | 134.442 | 136.757 | +1.7% |
| overwrite | 80 | 3000 | 163.345 | 176.226 | +7.9% |
| overwrite | 8192 | 3000 | 174.646 | 177.744 | +1.8% |
| rename | 80 | 1000 | 53.367 | 53.407 | +0.1% |
| rename | 1048576 | 1000 | 50.331 | 49.036 | -2.6% |
| rename | 8388608 | 1000 | 49.693 | 49.384 | -0.6% |
| range | 8192 | 2000 | 63.513 | 64.905 | +2.2% |
| range | 16384 | 2000 | 80.401 | 78.829 | -2.0% |
| range | 32768 | 2000 | 65.917 | 65.573 | -0.5% |
| range | 1048576 | 2000 | 164.527 | 162.950 | -1.0% |
| range | 8388608 | 2000 | 253.408 | 231.740 | -8.6% |
| append | 80 | 1000 | 118.278 | 103.845 | -12.2% |
| append | 262144 | 1000 | 147.546 | 137.014 | -7.1% |
| append | 1048576 | 1000 | 167.827 | 160.098 | -4.6% |

21개 크기별 일반 작업 모두 SQL 수·반환 행 수·반환 BLOB 바이트가 같다.
workerd의 500회 credential stat은 깊이 1/16/64에서 각각 SQL 500회,
읽힌 행 3,500/26,000/98,000이다. Replacement rename도 SQL 11회로 같다.

빈 파일 읽기는 3,000회 비교에서 +15.0%였다. paired trial별 비율의
중앙값은 +8.9%이며, 중앙값끼리의 비율과 차이가 나므로 위 표를 그대로
남겼다. 30,000회로 늘린 독립 프로세스 9쌍에서는 **448.536 → 467.169 ms
(+4.2%, 약 0.62 µs/회 추가)**였다. 따라서 장기 반복에서는 작은 차이지만
초기 수천 회의 +15%까지 없어졌다고 주장하지 않는다.

동일 소스 30,000회 A/A 대조 7쌍은 **444.013 → 441.536 ms (-0.6%)**였다.
[추가 측정](posix-path-fix/empty-final-profile.json)과
[대조군](posix-path-fix/empty-control-profile.json)을 함께 보관한다.

### Git 워크로드

같은 Linux에서 1,000개 파일 저장소, isomorphic-git 1.43.1, 실행 순서
before → after → after → before, 각 실행 3 trials의 중앙값이다.
큰 입력의 의도된 제한 검사는 시간 비교에서 제외했다. 일반 시나리오는
전후 모두 오류 없이 완료했다. 아래 개선 폭에는 런타임·호스트 편차가
포함되므로 경로 수정 자체의 가속 효과라고 단정하지 않는다.

| 연산 | 수정 전 ms | 수정 후 ms | 변화 |
| --- | ---: | ---: | ---: |
| populate | 130.879 | 121.854 | -6.9% |
| add-all | 705.340 | 678.258 | -3.8% |
| commit-initial | 16.107 | 14.979 | -7.0% |
| status-clean-0 | 92.776 | 85.529 | -7.8% |
| status-clean-1 | 67.697 | 69.238 | +2.3% |
| status-clean-2 | 70.094 | 69.566 | -0.8% |
| status-one-change | 73.600 | 70.198 | -4.6% |
| diff-one-change | 83.713 | 70.864 | -15.3% |
| add-one | 8.548 | 5.386 | -37.0% |
| commit-one | 12.200 | 9.579 | -21.5% |
| branch-create | 1.148 | 0.943 | -17.9% |
| checkout-old | 100.610 | 86.571 | -14.0% |
| checkout-main | 89.517 | 87.200 | -2.6% |
| push | 455.116 | 440.685 | -3.2% |
| add-20-individually-existing | 101.373 | 96.749 | -4.6% |
| add-20-bulk-existing | 8.296 | 7.549 | -9.0% |
| clone | 471.777 | 435.231 | -7.7% |

Git stat-cache 휴리스틱에 따라 SQL 수가 달라지는 작업이 있으므로, SQL
불변 주장은 위의 일반 FS 프로파일에 한정한다. 큰 clone의 EFBIG, 긴 diff의
E2BIG, 같은 초·같은 크기 변경을 놓치는 기존 stat 휴리스틱은 이번 범위에
포함하지 않았다.

## 검증 및 비용

- `npm run check`: Node 1,791개 + workerd 123개 = **1,914개 통과**.
- Linux 의미론 27/33, 기존 28개 집합 22/28.
- `npm run bench:check`: Node 구조 검사 17개, workerd 검사 28개 통과.
- 11개 번들 예산 유지. VFS 185,626 → 187,859 bytes, R2 opaque
  187,324 → 189,557 bytes. 추가 경로 로직으로 각 2,233 bytes 증가했다.
  상한 188,032/189,568 bytes를 높이지 않았다.
- 저장 스키마와 파일 핸들 API는 변경하지 않았다. 일반 경로의 SQL
  비용은 같다. Dot 경로는 사라졌던 접두 디렉터리의 존재·종류·검색 권한을
  확인하므로 추가 조회가 생긴다. 이 특수 경로의 동일 비용을 주장하지 않는다.

## 재현

```sh
npm run check
npm run bench:check
POSIX_COMPARE_LIBRARY=/path/to/baseline/dist POSIX_TRIALS=9 POSIX_REPEAT_FACTOR=10 npm run bench:posix
POSIX_COMPARE_LIBRARY=/path/to/baseline/dist POSIX_TRIALS=9 POSIX_REPEAT_FACTOR=100 POSIX_CASES=read-small POSIX_SIZES=0 npm run bench:posix
GIT_PROBE_VARIANT=fs GIT_PROBE_COUNTS=1000 GIT_PROBE_TRIALS=3 npm run bench:git
```

[기준 소스](posix-path-fix/baseline-source.tar.gz)는 이번 수정 직전 상태다.
이전 POSIX 최적화 1·5·6과 FS 모듈을 포함한다. Git HEAD만으로는 재현되지
않는다. [패치](posix-path-fix/applied.patch)와
[기준 해시](posix-path-fix/baseline-manifest.json)를 함께 보관한다.
