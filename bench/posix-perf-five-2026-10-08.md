# POSIX 의미론을 유지한 5개 성능 실험 — 2026-10-08

현재 POSIX completion 구현을 기준으로 1–5를 각각 독립적으로 시험했고,
다섯 변경을 모두 적용했다. 의미론은 바꾸지 않았다. 새 저장 구조,
영속 메타데이터 캐시, Git 전용 경로를 도입하지 않았다.

## 기준과 측정

HEAD만으로는 기준을 재현할 수 없다. 이번 작업 시작 시의 미커밋 소스와
빌드를 [baseline.tar.gz](posix-perf-five/baseline.tar.gz)에 보관하고,
[baseline manifest](posix-perf-five/baseline-manifest.json)로 소스를 식별한다.
각 실험은 이 동일한 기준에서 분기했으며, 다른 실험의 변경을 포함하지 않는다.
[trial1–5 패치와 원자료](posix-perf-five/)를 보관한다.

전용 시간 측정은 Linux neverland, Node 24.18.0, 기존 Node SQLite adapter에서
수행했다. 워밍업 후 서로 다른 프로세스의 before/after 순서를 AB/BA로
교대하여 9회씩 측정했다. 준비·결과 검증은 타이머 밖이다. 표의 ms는 반복
작업 전체의 중앙값이고, 증감률은 두 중앙값의 비율이다. 원자료에는 개별
표본과 paired-ratio bootstrap 95% 구간도 있으며, 이 구간은 중앙값 비율과
다른 통계량이다. Node returnedRows를 workerd 과금 rowsRead로 해석하지 않는다.

workerd 실제 SQLite 바인딩에서는 SQL 횟수·과금 읽기/쓰기 행을 별도로
측정했다. 운영 DO 네트워크 지연이나 실제 청구액을 측정한 것은 아니다.
해당 비용 시나리오는 한 DB를 순서대로 사용하며, wide 디렉터리 준비 이후의
핸들 작업에는 1,000개 형제 디렉터리가 있는 namespace 조회 비용도 포함한다.
작은 namespace의 1B 핸들 비용은 기존 benchmark가 별도로 지킨다.

## 독립 판정

| 번호 | 변경과 대표 작업 | 횟수 | 전 ms | 후 ms | 시간 변화 | 판정 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | 핸들 inode 재사용: fstat | 1500 | 31.569 | 17.912 | -43.3% | 적용 |
| 1 | 같은 변경: 8KiB fd readFile | 200 | 19.670 | 12.359 | -37.2% | 적용 |
| 2 | 부모 nlink 재계산 생략: 형제 디렉터리 1,000개에서 파일 생성 | 300 | 36.719 | 22.271 | -39.3% | 적용 |
| 2 | 같은 변경: 동일 부모 파일 rename | 500 | 157.821 | 129.257 | -18.1% | 적용 |
| 3 | 집합 삭제: 8MiB→0 truncate | 12 | 89.745 | 19.112 | -78.7% | 적용 |
| 3 | 같은 변경: 1MiB→32KiB+1 truncate | 40 | 23.743 | 12.803 | -46.1% | 적용 |
| 4 | 이전 청크 읽기 생략: 1MiB 전체 덮어쓰기 | 40 | 90.950 | 53.847 | -40.8% | 적용 |
| 4 | 같은 변경: 1B 어긋난 1MiB 쓰기 | 40 | 93.048 | 38.616 | -58.5% | 적용 |
| 5 | 비공유 alias 조회 생략: hard link가 있는 DB의 chmod | 1000 | 33.623 | 31.172 | -7.3% | 적용 |

5번의 독립 Node 시간 차이는 통계적으로 뚜렷하지 않았다. paired-ratio 구간은
chmod -8.8%~+3.5%, overwrite -5.2%~+10.2%다. **시간 개선이 입증됐다는
뜻으로 채택하지 않았다.** 동일 workerd 작업에서 SQL과 과금 행의 감소가
명확했고, 의미론 유지 및 비대상 경로 평가를 통과하여 비용 개선으로 채택했다.

2번은 트랜잭션에 디렉터리 namespace 변경이 전혀 없을 때만 COUNT를
생략한다. 혼합 트랜잭션에는 기존 정확한 재계산을 유지하는 보수적인 구현이다.
부모 시간과 token 갱신은 항상 유지하며, 디렉터리 nlink를 증분 추정하지 않는다.

3번의 축소만 적용했다. 확장 truncate의 큰 0 버퍼를 바꾸는 6번 후보와
반복 trigger 설치를 바꾸는 7번 후보는 이번 범위에 포함하지 않았다.
4번은 완전 덮어쓰기와 새/hole 청크의 이전 본문만 생략하며 부분 경계는 읽는다.
청크 UPSERT 배치나 저장 구조 변경은 추가하지 않았다.

## 실제 workerd 비용: 수정 전 → 통합 적용 후

| 작업 | SQL | 과금 rowsRead | 과금 rowsWritten |
| --- | ---: | ---: | ---: |
| fstat | 2 → 1 | 4 → 2 | 0 → 0 |
| fd-read | 5 → 3 | 8 → 4 | 0 → 0 |
| fstat-detached | 4 → 2 | 4 → 2 | 0 → 0 |
| fd-read-detached | 4 → 4 | 4 → 4 | 0 → 0 |
| fd-readfile-detached | 8 → 4 | 8 → 4 | 0 → 0 |
| create-wide | 8 → 8 | 1009 → 9 | 6 → 6 |
| rename-wide | 8 → 8 | 3012 → 2012 | 5 → 5 |
| truncate-zero-1048576 | 37 → 5 | 2074 → 2042 | 34 → 34 |
| truncate-zero-8388608 | 261 → 5 | 2524 → 2268 | 258 → 258 |
| truncate-boundary | 36 → 7 | 2077 → 2046 | 33 → 33 |
| write-full | 67 → 35 | 1073 → 1041 | 33 → 33 |
| write-byte | 5 → 5 | 1011 → 1011 | 2 → 2 |
| alias-chmod | 4 → 3 | 1014 → 3 | 1 → 1 |
| alias-write | 4 → 3 | 1019 → 8 | 2 → 2 |
| alias-shared-write | 4 → 4 | 1032 → 1031 | 5 → 5 |

truncate의 실제 삭제 행과 quota 갱신은 그대로다. SQL 횟수가 줄어도 저장소
쓰기 행이 없어지는 것은 아니다. rename의 남는 namespace 순회 비용과
핸들 inode 조회의 namespace 규모 의존성도 이번 변경이 해결하지 않는다.
기존 작은 namespace의 1B 읽기/쓰기는 각각 **3/5 SQL, 4/6 rowsRead,
0/2 rowsWritten**을 그대로 유지했다.

## 통합 전용 작업 시간

| 작업 | 크기/조건 | 횟수 | 전 ms | 후 ms | 시간 변화 |
| --- | ---: | ---: | ---: | ---: | ---: |
| fstat | 80 | 1500 | 31.307 | 16.997 | -45.7% |
| fd-read | 8192 | 200 | 18.482 | 10.473 | -43.3% |
| fd-read-detached | 8192 | 200 | 11.969 | 6.973 | -41.7% |
| create-wide | 0 | 300 | 28.015 | 24.795 | -11.5% |
| create-wide | 1000 | 300 | 38.165 | 24.775 | -35.1% |
| rename-wide | 1000 | 500 | 154.052 | 130.317 | -15.4% |
| truncate-zero | 1048576 | 40 | 29.142 | 12.156 | -58.3% |
| truncate-boundary | 1048576 | 40 | 23.130 | 13.421 | -42.0% |
| truncate-zero | 8388608 | 12 | 58.747 | 25.270 | -57.0% |
| write-full | 8192 | 500 | 28.311 | 23.011 | -18.7% |
| write-full | 1048576 | 40 | 79.755 | 31.626 | -60.3% |
| write-unaligned | 1048576 | 40 | 82.117 | 40.033 | -51.2% |
| write-byte | 1048576 | 1000 | 98.358 | 96.148 | -2.2% |
| alias-chmod | 0 | 1000 | 29.345 | 29.712 | +1.2% |
| alias-chmod | 1 | 1000 | 33.463 | 30.487 | -8.9% |
| alias-write | 1 | 300 | 17.167 | 16.833 | -1.9% |

## 의미론과 검증

- 기준과 각 독립 시제품 모두 기존 Linux 43개 trace를 통과했다.
- 실제 Linux로 세 trace를 추가 확인했다: 디렉터리 교체/nlink,
  청크 경계 덮어쓰기/truncate, hard-link 마지막 unlink 이후 truncate.
  **통합 46/46**, 기준과 각 독립 시제품도 확장된 Linux oracle **46/46**이다.
- recursive_triggers=ON의 live/shared/detached 청크 쓰기·축소·확장,
  디렉터리 재귀 copy·교체 rename·혼합 배치·rollback, alias metadata feed를
  검사하는 8개 회귀 테스트를 추가했다.
- `npm run check`: Node **1,821**, workerd **125**, 총 **1,946** tests와
  typecheck/lint/knip/품질/문서/패키지/실행 한도/tree-shaking 검사를 통과했다.
- `npm run bench:check`: 기존 Node SQL guard와 workerd **30개** 검사 통과.
  추가된 한 benchmark는 15개 workload의 정확한 SQL·과금 행을 지킨다.
- 11개 bundle preset을 기존 한도 변경 없이 통과했다. VFS는
  203,578→204,400B(+0.4%), FS adapter는 238,395→239,656B(+0.5%)다.

기존 지원 범위는 유지된다. descriptor는 owner 로컬이고, hard-link inline
본문은 이름마다 복제되며, opaque random write/truncate는 ENOTSUP이다.
이번 결과는 지원한 trace의 일치이며 POSIX API 전체 지원을 뜻하지 않는다.

## 재현 명령

```sh
npm run check
npm run bench:check
PERF_BEFORE=/path/to/baseline/dist PERF_LIBRARY=dist PERF_TRIALS=9 \
  PERF_OUTPUT=/tmp/five.json node bench/posix-perf-five.mjs
POSIX_COMPARE_LIBRARY=/path/to/baseline/dist POSIX_LIBRARY=dist \
  POSIX_TRIALS=9 POSIX_REPEAT_FACTOR=5 POSIX_OUTPUT=/tmp/ordinary.json \
  node bench/posix-profile.mjs
```

원자료, 시제품별 패치, 소스 식별자와 로그는 [posix-perf-five](posix-perf-five/)에 있다.

## 일반 작업 전후 비교

같은 Linux/Node 환경, AB/BA 9회, 반복형 작업 5배의 중앙값이다.

| 작업 | 크기/깊이 | 횟수 | 전 ms | 후 ms | 변화 |
| --- | ---: | ---: | ---: | ---: | ---: |
| stat-depth | 1 | 2500 | 68.735 | 68.910 | +0.3% |
| stat-depth | 16 | 2500 | 128.544 | 128.761 | +0.2% |
| stat-depth | 64 | 2500 | 636.522 | 630.764 | -0.9% |
| read-small | 0 | 1500 | 35.222 | 36.259 | +2.9% |
| read-small | 80 | 1500 | 48.836 | 52.357 | +7.2% |
| read-small | 8192 | 1500 | 60.342 | 64.661 | +7.2% |
| read-small | 32768 | 1500 | 96.667 | 97.627 | +1.0% |
| list-stat | 100 | 1 | 2.232 | 2.227 | -0.2% |
| list-stat | 1000 | 1 | 19.998 | 23.025 | +15.1% |
| create | 0 | 1500 | 114.179 | 115.782 | +1.4% |
| create | 80 | 1500 | 131.262 | 129.119 | -1.6% |
| create | 8192 | 1500 | 144.943 | 152.909 | +5.5% |
| overwrite | 0 | 1500 | 71.796 | 74.223 | +3.4% |
| overwrite | 80 | 1500 | 90.301 | 89.382 | -1.0% |
| overwrite | 8192 | 1500 | 96.295 | 96.439 | +0.1% |
| rename | 80 | 500 | 33.774 | 33.781 | +0.0% |
| rename | 1048576 | 500 | 32.289 | 31.676 | -1.9% |
| rename | 8388608 | 500 | 32.983 | 32.955 | -0.1% |
| rename-replace | 80 | 1 | 0.313 | 0.318 | +1.6% |
| rename-replace | 1048576 | 1 | 0.400 | 0.416 | +4.0% |
| rename-replace | 8388608 | 1 | 2.993 | 3.037 | +1.5% |
| range | 8192 | 1000 | 34.850 | 38.814 | +11.4% |
| range | 16384 | 1000 | 36.966 | 39.094 | +5.8% |
| range | 32768 | 1000 | 36.275 | 39.562 | +9.1% |
| range | 1048576 | 1000 | 81.217 | 86.631 | +6.7% |
| range | 8388608 | 1000 | 115.657 | 119.864 | +3.6% |
| append | 80 | 500 | 62.942 | 63.214 | +0.4% |
| append | 262144 | 500 | 65.653 | 62.497 | -4.8% |
| append | 1048576 | 500 | 73.574 | 73.406 | -0.2% |

## Git 워크로드

Git 전용 최적화 없이 동일 isomorphic-git 1.43.1, localhost native Git HTTP
remote에서 비교했다. `combined` promise-FS adapter(메타데이터 캐시와
opaque content tier 포함)를 전후 모두 사용했다. 이 adapter 설정은 이전
보고서의 다른 variant와 시간을 직접 비교할 수 없다. 1,000개 파일,
before/after/after/before 각 3회로 작업당 6표본이다. 큰 본문 작업은
각 프로세스에서 한 번 실행하여 전후 각 2표본만 있어 불확실성이 크다.

| 작업 | 표본 수(전/후 각각) | 전 ms | 후 ms | 변화 |
| --- | ---: | ---: | ---: | ---: |
| add-20-bulk-existing | 6 | 8.432 | 8.237 | -2.3% |
| add-20-individually-existing | 6 | 87.864 | 88.931 | +1.2% |
| add-all | 6 | 605.456 | 567.374 | -6.3% |
| add-one | 6 | 4.476 | 4.672 | +4.4% |
| branch-create | 6 | 0.992 | 0.985 | -0.7% |
| checkout-main | 6 | 55.232 | 53.892 | -2.4% |
| checkout-old | 6 | 55.494 | 53.884 | -2.9% |
| clone | 6 | 429.017 | 424.636 | -1.0% |
| clone-large | 2 | 1105.468 | 1115.721 | +0.9% |
| commit-initial | 6 | 13.333 | 13.257 | -0.6% |
| commit-one | 6 | 10.054 | 9.382 | -6.7% |
| diff-one-change | 6 | 37.994 | 38.647 | +1.7% |
| populate | 6 | 156.881 | 153.079 | -2.4% |
| push | 6 | 406.309 | 417.093 | +2.7% |
| push-large | 2 | 1247.739 | 1325.051 | +6.2% |
| status-clean-0 | 6 | 43.354 | 40.168 | -7.4% |
| status-clean-1 | 6 | 34.767 | 31.905 | -8.2% |
| status-clean-2 | 6 | 33.027 | 33.611 | +1.8% |
| status-one-change | 6 | 35.783 | 36.196 | +1.2% |
| write-9MiB | 2 | 23.720 | 26.669 | +12.4% |

`diff-1200-lines`는 전후 모두 E2BIG이며 성공 시간에 포함하지 않았다.
add-all/status 일부의 중앙값은 줄었지만 push는 +2.7%, clone은 -1.0%로
작은 차이다. Git 전체가 일관되게 빨라졌다고 주장하지 않는다.

## 일반 읽기/list의 회귀 의심 항목 재측정

첫 일반 평가에서 list/stat 1,000개 +15.1%, 8KiB range +11.4%가
관측되어 그대로 무회귀라고 결론 내리지 않았다. 같은 두 빌드로 AB/BA
15회, range/read 반복을 10배, list/stat을 회당 20회 실행하여 재측정했다.
`POSIX_LIST_REPEATS`는 이번에 추가한 opt-in 측정 설정이며 기본값은 기존 1이다.

| 작업 | 크기 | 횟수 | 전 ms | 후 ms | 중앙값 변화 | paired-ratio 95% 구간 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| read-small | 8192 | 3000 | 131.923 | 141.539 | +7.3% | -4.0%~+13.6% |
| list-stat | 1000 | 20 | 391.661 | 394.495 | +0.7% | -1.2%~+2.4% |
| range | 8192 | 2000 | 87.314 | 89.006 | +1.9% | -3.2%~+6.2% |
| range | 8388608 | 2000 | 255.894 | 246.960 | -3.5% | -7.7%~+9.3% |

list/range의 큰 회귀는 재현되지 않았다. 일반 8KiB readFile은 중앙값이
약 7% 높았지만 paired-ratio 구간에 0이 포함되고 전후 SQL 수는 같다.
따라서 모든 입력에서 시간이 같거나 빨라졌다고 보장하지 않는다. 큰 회귀는
확인하지 못했으며, 이 잔여 불확실성을 원자료와 함께 남긴다.

```sh
POSIX_COMPARE_LIBRARY=/path/to/baseline/dist POSIX_LIBRARY=dist \
  POSIX_CASES=list-stat,range,read-small POSIX_SIZES=1000,8192,8388608 \
  POSIX_TRIALS=15 POSIX_REPEAT_FACTOR=10 POSIX_LIST_REPEATS=20 \
  POSIX_OUTPUT=/tmp/focused.json node bench/posix-profile.mjs
```

`check-final.log`가 최종 전체 검사 로그이며, `bench-check.log`가 최종
성능 검사 로그다. `implementation.patch`는 이번 작업만의 소스 delta,
`measured-combined.tar.gz`는 측정한 통합 빌드, `final-manifest.json`과
`protocol-manifest.json`은 소스/평가/빌드 식별자다. 독립 시제품의 publication
parameter와 디렉터리 변경 표시 코드는 최종 통합 시 품질 한도를 지키도록
내부 인자 전달과 공통 helper로 정리했고, 동일 workerd 비용과 의미론을
최종 구현에서 다시 확인했다.
