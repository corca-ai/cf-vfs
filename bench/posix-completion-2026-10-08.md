# POSIX 차이 제거와 성능 평가 — 2026-10-08

기존 Linux 평가에서 남은 6개 차이를 모두 해결했다. 같은 33개는
27/33 → 33/33이며, hard link·위치 지정 I/O·truncate·sync를 추가한
43개도 실제 Linux와 일치한다. 완전한 POSIX 파일 시스템이라는 뜻은 아니다.

## 적용한 변경

- ctime을 별도로 저장하고 chmod/chown/rename에서 파일 mtime을 보존한다.
- 생성·삭제·이동 시 부모 디렉터리 시간을 같은 트랜잭션에서 갱신한다.
  한 트랜잭션의 같은 부모는 한 번만 갱신한다. 디렉터리 nlink도 갱신한다.
- 로컬 핸들은 inode를 참조한다. rename 이후와 마지막 unlink 이후에도
  같은 내용을 공유한다. 마지막 close에서 보존 데이터를 회수하며, owner
  재시작 시 고아 핸들의 quota를 회수하고 opaque GC를 예약한다.
- 위치 지정 읽기·쓰기는 해당 청크만 조회·변경한다. hole은 0으로 채운다.
- hard link가 같은 공개 inode·메타데이터·내용을 공유한다. 이름별 mutation
  token은 단조 증가하며 살아 있는 alias의 변경도 feed에 포함한다.
- opaque 업로드는 canonical path와 실제 symlink/dot traversal guard를
  영속화하여, 업로드 중 경로가 바뀌면 publication을 거절한다.
- opaque append는 기존 본문과 suffix를 스트리밍하여 대체한다.
- shell의 파일 인수·redirection·실행 스크립트·glob에서 dot traversal을
  보존한다. 기본 cd는 Bash의 logical-directory 의미를 유지한다.

`FileHandle.sync/datasync`는 DO storage.sync를 기다린다.
[Cloudflare 공식 저장소 문서](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#sync)는
이 완료 장벽을 설명한다. Node 시험 저장소는 메모리 DB이다.

## 측정 방법

Linux neverland, ext4, Node 24.18.0에서 실제 파일 시스템과 Node SQLite에
같은 trace를 실행한다. 작업 준비·결과 검증은 타이머 밖에 둔다.
일반 성능은 서로 다른 프로세스의 before/after 순서를 AB/BA로 번갈아
실행하며, 워밍업 후 7회 중앙값을 사용한다. 반복형 작업은 기존 반복의
5배를 실행한다. Node returnedRows는 Cloudflare 과금 rowsRead와 다르다.

실제 workerd SQLite 과금 행·SQL 횟수는 별도 측정한다. 배포된 DO의
네트워크 지연이나 운영 요금을 직접 측정한 것은 아니다. Git은
isomorphic-git 1.43.1과 localhost native Git HTTP remote를 사용하며,
1,000개 파일에서 before/after/after/before 각 3회 실행한다.

## 구조적 성능

| 작업 | 수정 전 | 수정 후 |
| --- | ---: | ---: |
| 100개 파일 배치 생성 SQL | 502 | 503 |
| 같은 작업 과금 rowsRead | 502 | 503 |
| 같은 작업 과금 rowsWritten | 401 | 402 |
| 1바이트 핸들 읽기: 32KiB / 8MiB | API 없음 | 모두 3 SQL, 4 rowsRead |
| 1바이트 핸들 쓰기: 32KiB / 8MiB | API 없음 | 모두 5 SQL, 6 rowsRead, 2 rowsWritten |

부모 시간 갱신은 namespace 변경 트랜잭션당 추가 SQL 한 번과 부모
쓰기 행을 요구한다. overwrite·append에서는 이 갱신을 하지 않는다.
초기 구현은 UPDATE 계획 때문에 batch100 rowsRead가 11,907까지 늘었다.
namespace 인덱스를 명시해 508로 줄였고, 부모 1–2개를 직접 bind해 504로
줄였다. 이벤트/feed가 없으면 RETURNING을 생략하여 최종 503이다.
이런 중간 상태는 적용 결과로 채택하지 않았다.

## 두 개의 독립 리뷰

두 서브에이전트가 병렬로 수정 없이 독립 리뷰하고 재검증했다.
타당한 모든 지적을 수용했다: hard-link 원래 이름 삭제 후 descriptor
읽기, copy overwrite의 중복 orphan과 quota 초과, mode000 신규 open,
불필요한 청크 쓰기, alias 변화 feed 누락, stale digest 때문에 쓰기 생략,
opaque receipt의 inode/nlink, read lease 만료, 상대 glob 표시, 재시작 GC
alarm, 내부 alias ID의 statById 노출이다. 회귀 테스트를 추가했다.
최종 재리뷰에서 두 리뷰어 모두 추가 차단 결함을 발견하지 못했다.

## 남는 제약

- 핸들은 한 SQL owner/프로세스에 속하며 RPC·eviction을 넘어서 유지되지 않는다.
  custom host는 시작 시 initialize()를 await하고, VfsDurableObject는 이를
  blockConcurrencyWhile 안에서 자동으로 수행한다.
- hard link의 inline 본문은 현재 이름마다 복제되며 실제 복제 바이트를 quota에
  계산한다. shared inode 저장 구조를 따로 분리한 구현은 아니다.
- immutable opaque 객체의 append는 본문 전체를 다시 업로드하므로 O(N)이다.
  opaque descriptor의 위치 지정 쓰기와 truncate는 ENOTSUP이다.
- POSIX API 전체, atime, 프로세스 공유 descriptor·locking·mmap·장치 파일은
  이번 구현의 지원 범위가 아니다. Linux 43/43은 해당 trace 집합의 결과이다.

원자료와 정확한 수정 전 source/dist, SHA256 manifest 및 구현 patch는
[posix-completion](posix-completion/)에 보관한다.

## Node SQLite times

| Operation | Bytes | Repeats | Before ms | After ms | Change |
| --- | ---: | ---: | ---: | ---: | ---: |
| stat-depth | 1 | 2500 | 57.300 | 63.923 | +11.6% |
| stat-depth | 16 | 2500 | 122.192 | 128.691 | +5.3% |
| stat-depth | 64 | 2500 | 600.805 | 613.536 | +2.1% |
| read-small | 0 | 1500 | 29.354 | 32.152 | +9.5% |
| read-small | 80 | 1500 | 45.100 | 50.956 | +13.0% |
| read-small | 8192 | 1500 | 52.952 | 67.906 | +28.2% |
| read-small | 32768 | 1500 | 96.444 | 100.282 | +4.0% |
| list-stat | 100 | 1 | 1.800 | 2.282 | +26.7% |
| list-stat | 1000 | 1 | 17.115 | 20.217 | +18.1% |
| create | 0 | 1500 | 88.776 | 116.883 | +31.7% |
| create | 80 | 1500 | 105.813 | 130.849 | +23.7% |
| create | 8192 | 1500 | 131.308 | 147.532 | +12.4% |
| overwrite | 0 | 1500 | 67.285 | 73.223 | +8.8% |
| overwrite | 80 | 1500 | 89.677 | 101.991 | +13.7% |
| overwrite | 8192 | 1500 | 96.224 | 101.917 | +5.9% |
| rename | 80 | 500 | 26.284 | 32.624 | +24.1% |
| rename | 1048576 | 500 | 24.998 | 31.064 | +24.3% |
| rename | 8388608 | 500 | 25.769 | 32.742 | +27.1% |
| rename-replace | 80 | 1 | 0.256 | 0.299 | +16.7% |
| rename-replace | 1048576 | 1 | 0.372 | 0.411 | +10.4% |
| rename-replace | 8388608 | 1 | 1.725 | 4.291 | +148.8% |
| range | 8192 | 1000 | 33.457 | 37.726 | +12.8% |
| range | 16384 | 1000 | 35.915 | 37.169 | +3.5% |
| range | 32768 | 1000 | 31.362 | 37.081 | +18.2% |
| range | 1048576 | 1000 | 78.607 | 81.495 | +3.7% |
| range | 8388608 | 1000 | 121.937 | 119.609 | -1.9% |
| append | 80 | 500 | 62.794 | 62.204 | -0.9% |
| append | 262144 | 500 | 61.155 | 69.153 | +13.1% |
| append | 1048576 | 500 | 71.534 | 72.435 | +1.3% |

## Git times

| Operation | Before ms | After ms | Change |
| --- | ---: | ---: | ---: |
| populate | 115.065 | 146.072 | +26.9% |
| add-all | 553.050 | 601.666 | +8.8% |
| commit-initial | 15.202 | 14.701 | -3.3% |
| status-clean-0 | 82.654 | 78.891 | -4.6% |
| status-clean-1 | 66.248 | 69.415 | +4.8% |
| status-clean-2 | 62.054 | 66.748 | +7.6% |
| status-one-change | 62.722 | 68.034 | +8.5% |
| diff-one-change | 66.345 | 70.963 | +7.0% |
| add-one | 4.992 | 4.913 | -1.6% |
| commit-one | 10.205 | 10.335 | +1.3% |
| branch-create | 0.985 | 0.973 | -1.2% |
| checkout-old | 81.386 | 87.571 | +7.6% |
| checkout-main | 77.498 | 86.392 | +11.5% |
| push | 409.052 | 401.091 | -1.9% |
| add-20-individually-existing | 83.937 | 89.908 | +7.1% |
| add-20-bulk-existing | 10.344 | 7.955 | -23.1% |
| clone | 390.010 | 438.349 | +12.4% |
| push-large | 1364.088 | 1423.498 | +4.4% |
| clone-large (EFBIG 거절) | 848.442 | 835.220 | -1.6% |
| write-9MiB (EFBIG 거절) | 5.021 | 5.493 | +9.4% |
| diff-1200-lines (E2BIG 거절) | 0.547 | 0.368 | -32.7% |

표의 양수는 시간 증가이다. 부모 메타데이터 갱신 때문에 독립 파일 생성은
12.4–31.7%, 교체 없는 rename은24.1–27.1% 느려졌다. 80B 생성은 파일당
70.5→87.2µs, rename은 회당52.6→65.2µs 정도이다. 읽기와 목록 조회도
메타데이터 필드 추가 비용이 남으며, 8KiB read의28.2% 증가를 포함해
결과를 모두 기록했다. 모든 작업의 기존 시간을 유지했다고 주장하지 않는다.

단회8MiB replacement rename은 종합 실행에서1.725→4.291ms로
불안정했다. 추가 격리AB/BA21회에서는1.765→1.760ms(-0.3%)였고,
p10–p90은 전1.637–1.938ms, 후1.650–1.827ms였다. 80B/1MiB 격리
재측정은 각각+10.5%/+15.0%였다. 종합 측정도 삭제하지 않고 보관한다.

Git의1,000파일 작업은 variant별6개 표본(ABBA각3회 두블록)의 중앙값이며,
large 시나리오는 각2개 표본이다. 기본 inline limit에서 clone-large와
write-9MiB는 EFBIG, diff-1200-lines는 기존 비교 예산의 E2BIG 거절이다.
이 세 행은 성공 작업의 성능 개선으로 해석하면 안 된다. 나머지 실제
push/clone 결과의 commit과 파일 내용을 검증했다. 명시적인 content tier를
선택하면 큰 본문을 저장할 수 있다. isomorphic-git의 같은 초·같은 크기
수정을 놓치는 캐시 사례는 native/VFS 양쪽에 남는다.

MemoryOpaqueStore 프로토콜 측정에서 opaque append1B는 기존1MiB 본문에 대해 get1회·put1회로1,048,577B의
대체 객체를 만든다. 본문 전체를 다시 업로드하는 비용을 없앴다고 주장하지
않는다. `opaque-append.json`에 연산 수와 결과 크기를 보관한다.

## 전체 검증과 패키지 크기

- `npm run check`: Node1,813 + workerd125 = **1,938tests**. Linux43/43,
  type/lint/knip/quality/package/실행 제한/문서/11개 tree-shaking preset 통과.
- `npm run bench:check`: Node SQL gate와 workerd 성능 검사 **29개 통과**.
  부모 시간 갱신에 따른+1SQL/+1write의 정확한 비용을 명시적으로 갱신했다.
  overwrite·append·find·range·maintenance의 기존 SQL 비용 검사를 유지했다.
- VFS Worker bundle187,859→203,578B(**+8.4%**). 현재 fs-adapter238,395B,
  fs-tiered248,084B. 새 기능과 migration 비용을 포함하므로 기존 byte 예산은
  그대로 유지하지 못했고 공식 recording 절차로 재기록했다. 핸들 구현은
  VFS-only preset에 포함되지 않는다.
- 열린 핸들100개가 있어도 무관한 파일 단일 unlink는 **12SQL**이며, 전체
  핸들을 SQL로 순회하지 않는다. 이 마지막 최적화는 일반 profile/Git에 없는
  경로이며, 별도 비용 회귀 테스트와 두 독립 재리뷰를 완료했다.

측정 빌드(`measured-dist.tar.gz`)와 최종 source/dist manifest를 각각
보관한다. 마지막 단일-unlink pin 최적화 후 Linux43개 trace도 다시
확인했다. 재시작·opaque lease·권한과 실패 후 상태를 회귀 검사에 포함한다.
