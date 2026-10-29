import json, math, statistics, sys, collections
def key(stage): return (stage['group'], stage['operation'], stage.get('files'), stage.get('cache'))
def ratios(path):
    d = json.load(open(path))
    times = collections.defaultdict(lambda: {'baseline': [], 'candidate': []})
    for row in d['rows']:
        if row['profile']: continue
        times[key(row['stage'])][row['version']].append(row['ms'])
    out = {}
    for k, v in times.items():
        b, c = statistics.median(v['baseline']), statistics.median(v['candidate'])
        if b > 0 and c > 0: out[k] = c / b
    return out
def gm(values): return math.exp(sum(math.log(x) for x in values) / len(values))
sessions = sys.argv[1:]
per = {s: ratios(s) for s in sessions}
for s, r in per.items():
    fam = collections.defaultdict(list)
    for k, v in r.items(): fam[k[0]].append(v)
    print(s.split('/')[-1], 'workloads', len(r), 'overall', round(gm(r.values()), 4), {f: round(gm(v), 3) for f, v in sorted(fam.items())})
# pooled per workload across AB sessions
ab = [r for s, r in per.items() if 'local-ab' in s]
if ab:
    common = set.intersection(*(set(r) for r in ab))
    pooled = {k: gm([r[k] for r in ab]) for k in common}
    overall = [gm(r.values()) for r in ab]
    mean = statistics.mean(overall); sd = statistics.stdev(overall) if len(overall) > 1 else 0
    print('AB session overall geomeans', [round(x, 4) for x in overall], 'mean', round(mean, 4), 'sd', round(sd, 4))
    worst = sorted(pooled.items(), key=lambda kv: -kv[1])[:8]
    best = sorted(pooled.items(), key=lambda kv: kv[1])[:8]
    print('slowest pooled ratios', [(k, round(v, 3)) for k, v in worst])
    print('fastest pooled ratios', [(k, round(v, 3)) for k, v in best])
    over5 = [(k, round(v, 3), [round(r[k], 3) for r in ab]) for k, v in pooled.items() if v > 1.05]
    print('pooled >5% slower', over5)
