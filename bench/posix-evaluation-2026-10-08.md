# POSIX 호환성과 성능: 10개 독립 실험 — 2026-10-08

목표는 Git 전용 경로를 추가하지 않고 POSIX 파일 시스템의 의미론과
성능 프로파일에 가까워지는 것이다. **1·5·6을 적용했고, 나머지 7개는
시제품만 보관했다.** 실패한 시제품은 공개 런타임이나 패키지에 들어가지 않는다.

## 평가 방법과 범위

- Linux: `ssh neverland`, Ubuntu, kernel 5.15, x86_64, ext4, Node 24.18.0.
  Node는 공식 배포본의 SHA256을 확인하고 전용 임시 디렉터리에 설치했다.
  시스템 Node나 SSH 서버 설정은 바꾸지 않았다.
- Cloudflare: 로컬 workerd의 실제 Durable Object SQLite 바인딩으로
  statements, rowsRead, rowsWritten을 별도로 측정했다. 배포된 DO의 네트워크
  지연이나 운영 비용을 측정한 것은 아니다.
- 실제 Linux 파일과 Node SQLite VFS에 같은 작업을 실행했다. 준비·파일 생성과
  결과 검증은 타이머 밖에 둔다. 크기별 새 파일 시스템, 1회 워밍업,
  5회 반복의 중앙값을 사용한다. native/VFS 실행 순서를 번갈아 바꾼다.
  stat/append는 실행 순서를 뒤집어 9회 재측정했다.
- 개별 실험은 각각 동일한 작업 시작 상태에서 분기했다. 실험 5가 SQLite
  prepare 비용을 크게 줄이므로, 1·2·3·6·7·8의 후속 비교는 양쪽 모두 같은
  prepared-statement 캐시를 사용했다. 초기 캐시 없는 측정도 원자료에 남겼다.
- Node의 `returnedRows`는 결과 행 수이며 Cloudflare의 과금 행 수가 아니다.
  `blobBytes`는 SQL 경계로 반환된 ArrayBuffer의 크기 합계다. heap peak,
  SQLite 내부 페이지 읽기, 네트워크 전송량을 뜻하지 않는다.
- 의미론 평가는 Linux의 반환값·오류 코드뿐 아니라 성공/실패 뒤의 파일 내용,
  디렉터리, symlink 상태까지 비교한다. `utimes`는 VFS 메타데이터로 시험용
  연결을 제공한다. 공개 `utimes` API가 생겼다는 뜻은 아니다.
- Git은 isomorphic-git 1.43.1, native Git 2.34.1이 제공하는 localhost HTTP
  원격 저장소로 시험했다. 100/1,000파일, 각 3회. 실제 push와 clone을 실행했다.
  Git/원격 네트워크와 압축 CPU까지 포함하는 시간이다.

작업 시작 시점은 HEAD `edef5918735e54df5c46e6a5ea5bbfc43b0ff2a2`에 이전
작업의 미커밋 FS 모듈이 포함된 상태다. HEAD만 체크아웃하면 기준 상태가
재현되지 않는다. 정확한 [기준 소스](posix-evaluation/baseline-source.tar.gz),
[소스 해시](posix-evaluation/baseline-manifest.json),
[최종 적용 패치](posix-evaluation/applied.patch)를 함께 보관했다.

## 10개 실험의 독립 판정

시간은 표에 적힌 반복 작업 전체의 중앙값(ms)이다.

| 번호 | 실험 | 정량 결과 / 의미론 결과 | 판정 |
| --- | --- | --- | --- |
| 1 | 경로 조회와 권한 검사를 한 호출 안에서 통합 | credential stat 500회, 깊이 16: 41.337 → 25.139ms, **39.2% 감소**. SQL 1,000 → 500. workerd rowsRead는 깊이별로 전후 동일 | 적용 |
| 2 | 작은 파일의 메타데이터와 본문을 한 SQL로 조회 | 80B·8KiB 읽기 300회 SQL 600 → 300. 하지만 빈 파일 5.866 → 6.602ms(**12.6% 증가**), 80B 8.359 → 8.672ms. 8KiB는 12.319 → 11.501ms | 보류: 호출 수 감소가 일관된 지연 개선으로 이어지지 않음 |
| 3 | 수동 이벤트 연결 없이 list/stat 캐시 자동 검증 | PRAGMA data_version 방식: 1,000개 list/stat 16.961 → 10.530ms, SQL 1,002 → 1,003. 같은 연결에서 파일을 1B → 6B로 바꾼 뒤 캐시는 **1B를 반환** | 제외: 캐시 정확성 실패 |
| 4 | mtime/ctime/inode 규칙 개선 | chmod 때 mtime 보존 시제품: 일치 **21/28 → 21/28**. mtime 사례는 고쳤지만 ctime 증가 사례가 새로 실패 | 제외: 별도 ctime 영속화 없이 한 필드로 두 의미를 구현할 수 없음 |
| 5 | 생성·덮어쓰기의 반복 SQL prepare 제거 | Node 포트에서 최대 256개의 statement 재사용. 독립 생성 300회 72.1–76.4%, 덮어쓰기 58.4–60.0% 시간 감소, SQL/결과 행 수 동일 | 적용: **Node testing 어댑터에 한정** |
| 6 | rename 교체 시 중복 대상 조회 제거 | workerd 교체 rename **12 → 11 SQL**, rowsRead 1행 감소, rowsWritten 동일. Node는 BEGIN/COMMIT 포함 **14 → 13 SQL** | 적용: 이미 트랜잭션 안에서 읽은 대상 row 재사용 |
| 7 | 작은 ranged read도 선택한 바이트만 반환 | 8KiB 파일에서 16B 읽기 200회 반환 BLOB **1,638,400 → 3,200B**. 그러나 6.674 → 8.208ms(**23.0% 증가**), SQL 400 → 401 | 보류: layout 조회를 함께 줄이는 후속 구현 필요 |
| 8 | append에서 가득 찬 tail BLOB 조회 생략 | 청크 경계 시작 append 100회 반환 BLOB **267,094 → 4,950B**, 98.1% 감소. 같은 prepare 조건에서도 크기별 시간이 엇갈림; 초기 캐시 없는 비교에서 지연 8.9–32.0% 증가 | 보류: 본문 감소는 확인했지만 안정적인 지연 개선은 확인하지 못함 |
| 9 | 이동·삭제 뒤에도 읽을 수 있는 최소 핸들 | 핸들별 snapshot 시제품 일치 **21/28 → 23/28**. 두 핸들의 shared-write 사례에서 다른 핸들은 `new` 대신 **`old`**를 읽음 | 제외: 읽기 수명만 유지하고 동일 inode의 공유 상태를 잃음 |
| 10 | 큰 본문의 symlink 쓰기·append 투명화 | append 1B에 기존 크기+1B 전체 업로드: 2,049 / 1,048,577 / 9,437,185B. 업로드 도중 symlink를 `/a`→`/b`로 바꾸면 캡처한 chain guard가 무효인데도 **성공하고 `/a`를 덮어씀** | 제외: 경쟁 상태에서 guard 의미론 실패, 쓰기 증폭도 큼 |

1은 namespace에 symlink가 없고 trailing slash가 없는 credential stat에
적용한다. symlink, trailing slash, 일반 무권한-context stat은 기존 경로를
사용한다. 권한·없어진 조상·missing target 검사를 생략하지 않는다. 초기
시제품은 모든 조상의 전체 entry를 반환해 오히려 느렸으며, 조상의 필요한
권한 필드만 SQL에서 집계하는 버전으로 다시 비교한 뒤 채택했다.

6은 본문 복사나 읽기를 하지 않는다. **교체되는 기존 대상의 청크 삭제 비용은
남는다.** workerd에서 80B/1MiB/8MiB 대상의 rowsWritten은 각각 9/12/40이다.
SQL 개수가 일정하다고 교체 rename의 전체 비용까지 본문 크기와 무관하다고
주장하지 않는다. 교체 없는 rename은 기존에도 본문을 읽지 않았다.

시제품은 [trials](posix-evaluation/trials)에 패치로 보관했다. 9번은
[핸들 시제품](posix-evaluation/trials/9.mjs)이다. 3·10의 재현기는
[capability probes](posix-capability-probes.mjs)다. 이 코드는 시험용이며 지원
API가 아니다. 초기 `3-profile.json`은 캐시가 켜지지 않았던 시험이다. 판정에는
이를 쓰지 않고 수정한 `3-active-profile.json`과 stale-read 재현을 사용했다.

## 적용한 결과를 합친 전후 비교

아래 수치는 Node SQLite 전체 변경의 효과다. 5번 영향이 크므로 이를
Cloudflare의 commit/push 성능 향상으로 해석하면 안 된다.

| 작업 | 전 ms | 후 ms | 시간 감소 |
| --- | --- | --- | --- |
| 80B 파일 생성 300회 | 86.875 | 20.818 | 76.0% |
| 8KiB 파일 생성 300회 | 85.777 | 22.349 | 73.9% |
| 80B 파일 덮어쓰기 300회 | 40.168 | 14.367 | 64.2% |
| 8KiB 파일 덮어쓰기 300회 | 48.238 | 16.977 | 64.8% |
| 빈 파일 읽기 300회 | 15.687 | 6.342 | 59.6% |
| 8KiB 파일 읽기 300회 | 25.022 | 11.894 | 52.5% |
| 1,000개 list + stat | 38.022 | 17.075 | 55.1% |
| 깊이 16의 credential stat 500회, 9회 재측정 | 62.414 | 25.770 | 58.7% |
| 깊이 64의 credential stat 500회, 9회 재측정 | 201.638 | 122.167 | 39.4% |
| 256KiB 파일 append 100회, 9회 재측정 | 20.224 | 12.268 | 39.3% |

최초 합산 평가에서 256KiB append 중앙값은 21.071 → 23.683ms로
나빠 보였다. trial 분포가 크게 갈려 역순·9회로 재측정했다. 최종 범위는
전 18.926–25.123ms, 후 9.840–22.560ms다. 모든 입력에서 단 한 번의
측정도 더 느리지 않다는 보장은 하지 않는다.

workerd에서 credential stat 500회 SQL은 깊이 1/16/64 모두
1,000 → 500이다. 과금 rowsRead는 각각 **3,500 / 26,000 / 98,000으로
변하지 않았다.** 최종 로컬 wall time은 5/11/60ms였고 기준은 5/15/69ms였다.
이는 1회 샘플과 coarse clock이므로 Cloudflare 지연 개선율의 확정값으로
쓰지 않았다. 반복 가능하고 CI에서 고정한 근거는 SQL/과금 행 수다.

### Git: 1,000파일, 각 3회 중앙값

| 작업 | 전 ms | 후 ms | 시간 감소 |
| --- | --- | --- | --- |
| add-all | 1139.844 | 546.423 | 52.1% |
| commit-initial | 18.291 | 12.868 | 29.7% |
| status-clean-2 | 123.523 | 58.443 | 52.7% |
| diff-one-change | 141.119 | 60.780 | 56.9% |
| branch-create | 1.424 | 0.970 | 31.9% |
| checkout-main | 154.217 | 76.374 | 50.5% |
| push | 456.544 | 384.131 | 15.9% |
| clone | 882.170 | 381.446 | 56.8% |
| add-one | 4.517 | 4.642 | **-2.8%** |

100/1,000파일 정상 시나리오 **96/96이 전후 모두 성공**했다. 위 작업들의
SQL 개수는 동일하다. 단일 add에는 의미 있는 개선을 관측하지 못했다.
`fsCallMs`는 병렬 호출의 소요 시간을 합산한 진단값이므로 전체 지연보다
클 수 있다. 위 표에는 이것을 사용하지 않았다.

기존 한계도 재현했다: tier 없이 8MiB를 넘는 write/pack clone은 EFBIG,
1,200줄 diff는 비교 셀 예산 때문에 E2BIG, Git의 같은 초·같은 크기 stat
휴리스틱은 변경을 놓친다. 이번에 해결했다고 주장하지 않는다. 새 핵심
구현에 Git 전용 분기를 추가하지 않았다.

## 의미론과 기존 평가 보존

- Linux oracle: **21/28 → 21/28 (75%)**. 전체 POSIX 호환률을 뜻하지 않는다.
  7개 차이는 chmod mtime, rename mtime, 자식 생성 시 부모 mtime,
  symlink 뒤 `..`, open 후 rename/unlink, 두 핸들의 shared write다.
- `npm run check`: 기존 **1,904 → 1,907 테스트**가 모두 통과했다.
  Node 1,785, workerd 122. 새 Linux oracle 검사 28개도 별도 실행하며,
  7개 기존 차이를 명시한다. 새 차이나 차이가 사라지는 경우에도 검토를
  요청하도록 실패시켜 무심코 기준을 갱신하지 못하게 했다.
- `npm run bench:check`: Node 구조적 측정 17개와 workerd benchmark
  28개 통과. 기존 행/문장 제한을 완화하지 않았다. 새 stat/rename 비용을
  `posix-cost.bench.ts`에서 고정했다.
- 11개 tree-shaking fixture와 기존 번들 예산 모두 통과. VFS 번들은
  **183,528 → 185,626B (+2,098B, 1.14%)**, 기존 제한 188,032B.
  fs-adapter 192,499 → 194,597B, fs-tiered 202,175 → 204,273B.
  shell/interactive/개별 applet 크기는 그대로다. 예산 파일은 이번 실험에서
  높이지 않았다.
- 타입, 포맷·lint, Knip, 코드 복잡도, 실행 한도, 패키지 consumer,
  문서 링크도 통과했다.

추가한 검사는 권한 우회, missing entry의 오류, symlink/trailing slash,
rename inode 유지와 중복 조회를 보호한다. 성공 후보의 기능을 기존
어댑터에 합쳤으며 새 런타임 의존성은 추가하지 않았다.

## 재현

```sh
npm ci
npm run check
npm run bench:check
npm run bench:posix
# 원격 Linux에서도 같은 명령을 실행하면 native/Linux와 실시간 비교한다.
node bench/posix-semantics.mjs
GIT_PROBE_VARIANT=fs GIT_PROBE_OUTPUT=/tmp/git-final.json npm run bench:git
```

기록된 Linux 결과와 비교하는 `npm run test:posix`는 macOS에서도 실행한다.
기준 소스와 개별 실험을 재구성하려면 저장소 루트에서 다음 순서를 사용한다.

```sh
repo="$PWD"
trial_dir="$(mktemp -d /tmp/cf-vfs-posix-replay.XXXXXX)"
tar -xzf bench/posix-evaluation/baseline-source.tar.gz -C "$trial_dir"
ln -s "$repo/node_modules" "$trial_dir/node_modules"
# 1..8,10 중 시험할 패치를 선택한다. 9는 fs.open 시험용 외부 함수다.
(cd "$trial_dir" && patch -p1 < "$repo/bench/posix-evaluation/trials/6.patch")
# 공정한 core 비교에는 양쪽에 5.patch를 똑같이 적용한다.
(cd "$trial_dir" && "$repo/node_modules/.bin/tsc" -p tsconfig.build.json)
POSIX_LIBRARY="$trial_dir/dist" POSIX_CASES=rename,rename-replace \
  POSIX_OUTPUT=/tmp/posix-replay.json node bench/posix-profile.mjs
```

원자료는 [평가 디렉터리](posix-evaluation)에 있다. `before-final-profile` /
`final-profile`은 합산 5회 측정, `before-repeat-profile` / `final-repeat-profile`은
stat/append 9회 재측정, `*-cached-profile`은 공통 Node prepare 조건의 개별
실험이다. `before-git` / `final-git`은 Git 전체 기록, `*-semantics`와
`*-capabilities`는 의미론과 경쟁 조건의 실제 출력이다. 거부한 패치를
그대로 제품에 적용해서는 안 된다.
