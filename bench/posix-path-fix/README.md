# 경로 해석 수정 평가 자료

최종 구현의 일반 FS 측정은 `accepted-profile.json`, Git 측정은
`before/after-accepted[-repeat]-git.json`, Linux 의미론은
`accepted-linux-semantics.json`이다. `accepted-*-summary.json`은 원시
측정의 중앙값 요약이다. `empty-final-profile.json`은 최종 구현의
빈 파일 읽기 30,000회 비교이며 `empty-control-profile.json`은 동일
소스 A/A 대조군이다. 검사 로그는 `accepted-check.log`와
`accepted-bench-check.log`이다.

`baseline-source.tar.gz`는 수정 직전 소스, `baseline-manifest.json`과
`applied-manifest.json`은 소스 SHA-256이다. `applied.patch`는 이 기준에서
라이브러리 소스에 적용한 변경만 포함한다. 새 테스트와 평가 코드는
현재 저장소에서 확인한다. 기준 소스에는 이전에 적용한 FS 어댑터와
POSIX 최적화가 이미 포함되어 있다.

그 밖의 before/after, paired, isolated, hot, steady 파일은 초기 구현 및
측정 방법 검증 자료다. 동일 프로세스 paired 방식은 동일 소스 A/A에서도
편향이 있어 최종 판정에 쓰지 않았다. isolated/hot/steady 자료는 별도
프로세스 및 반복 횟수의 영향을 확인한 중간 측정이다. 이를 최종 소스의
측정으로 취급하지 않는다.

`*-control-profile.json`의 before/after는 실제로 같은 기준 소스의 별도
복사본이다. 중간 코드의 성능 저하를 최종 성능으로 오해하지 않도록
[평가 보고서](../posix-path-fix-2026-10-08.md)의 최종 표를 참고한다.
