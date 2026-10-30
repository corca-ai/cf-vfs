"""Rebuilds the S1 and S3 agent-evaluation wikis and their graded end states.

Copied from the generators the agent evaluations used on 2026-10-29 (pilot
`fixture.py` and `scenarios.py`); both are seeded, so the pages and the
expected files are the ones the agents saw. Usage: python3 -I fixtures.py OUT
writes OUT/s1.json and OUT/s3.json as {"files": {path: text}, "expected": {...}}.
"""
import json
import random
import re
import sys

WORDS = ("the team keeps this page current and reviews it every quarter before planning starts "
         "ask in the channel if something is unclear or out of date and link the source when you "
         "change a process so that people who read it later understand why it changed").split()


def title(stem):
    return " ".join(w.capitalize() for w in stem.split("-"))


def s1():
    rng = random.Random(20261029)
    pages = {
        "engineering": ["deploy-guide", "deploy-guide-legacy", "code-review", "testing", "architecture",
                        "api-style", "incident-response", "oncall", "monitoring", "feature-flags"],
        "ops": ["backups", "access-control", "vendors", "budget", "hardware"],
        "people": ["onboarding", "offboarding", "benefits", "travel", "remote-work", "hiring", "interview-loop"],
        "product": ["roadmap", "release-notes", "pricing", "customer-feedback", "glossary"],
        "": ["index", "faq", "contacts"],
    }
    tags_all = ["engineering", "process", "people", "policy", "ops", "product", "reference", "security"]
    broken_targets = ["security-policy", "q3-okrs", "payroll", "design-system", "status-page"]
    words = ("the team keeps this page current and reviews it every quarter before planning starts "
             "ask in the channel if something is unclear or out of date and link the source").split()

    def sentence(n):
        return " ".join(rng.choice(words) for _ in range(n)).capitalize() + "."

    stems = [s for group in pages.values() for s in group]
    paths = {s: (f"{d}/{s}.md" if d else f"{s}.md") for d, group in pages.items() for s in group}
    deploy_forms = ["[[deploy-guide]]", "[[deploy-guide|deploy docs]]", "[[deploy-guide#rollback]]",
                    "[[deploy-guide#rollback|rolling back]]"]
    deploy_linkers = rng.sample([s for s in stems if not s.startswith("deploy-guide")], 9)
    legacy_linkers = rng.sample([s for s in stems if not s.startswith("deploy-guide")], 4)
    broken_linkers = {b: rng.sample([s for s in stems if s != "deploy-guide-legacy"], rng.randint(1, 3))
                      for b in broken_targets}
    files, tags_of = {}, {}
    for stem in stems:
        tags = sorted(rng.sample(tags_all, rng.randint(1, 3)))
        tags_of[stem] = tags
        links = [f"[[{t}]]" for t in rng.sample([s for s in stems if s != stem and not s.startswith("deploy-guide")], 3)]
        if stem in deploy_linkers:
            links.append(rng.choice(deploy_forms))
        if stem in legacy_linkers:
            links.append("[[deploy-guide-legacy]]")
        links += [f"[[{b}]]" for b, who in broken_linkers.items() if stem in who]
        rng.shuffle(links)
        body = [f"---\ntitle: {title(stem)}\ntags: [{', '.join(tags)}]\n---\n", f"# {title(stem)}\n"]
        for i in range(0, len(links), 2):
            body.append(f"{sentence(rng.randint(8, 16))} See {' and '.join(links[i:i+2])}.\n")
        if stem == "deploy-guide":
            body.append("## Rollback\n\nRevert the release tag and redeploy the previous build.\n")
        files[paths[stem]] = "\n".join(body)
    link = re.compile(r"\[\[deploy-guide(?=[\]|#])")
    expected = {}
    for path, text in files.items():
        if path == "engineering/deploy-guide.md":
            text = text.replace("title: Deploy Guide", "title: Release Process").replace(
                "# Deploy Guide", "# Release Process")
            path = "engineering/release-process.md"
        expected[path] = link.sub("[[release-process", text)
    final = {("release-process" if s == "deploy-guide" else s): t for s, t in tags_of.items()}
    broken = sorted({(("engineering/release-process.md" if paths[s] == "engineering/deploy-guide.md" else paths[s]), b)
                     for b, who in broken_linkers.items() for s in who})
    expected["reports/broken-links.md"] = "# Broken links\n\n" + "".join(f"- {p}: {t}\n" for p, t in broken)
    lines = ["# Tags\n"]
    for tag in sorted({t for ts in final.values() for t in ts}):
        lines.append(f"\n## {tag}\n\n" + "".join(f"- [[{s}]]\n" for s in sorted(s for s, ts in final.items() if tag in ts)))
    expected["tags/index.md"] = "".join(lines)
    return files, expected


def s3(count=2000):
    rng = random.Random(20261031)

    def sentence(n):
        return " ".join(rng.choice(WORDS) for _ in range(n)).capitalize() + "."

    folders = ["eng", "eng/api", "eng/infra", "product", "people", "ops", "sales", "legal", "design", "data"]
    stems = [f"{rng.choice(['topic', 'note', 'spec', 'howto', 'guide', 'log'])}-{index:04d}" for index in range(count)]
    paths = {stem: f"{rng.choice(folders)}/{stem}.md" for stem in stems}
    weights = [1 / (rank + 1) ** 0.9 for rank in range(len(stems))]
    popular = stems[:]
    rng.shuffle(popular)
    files, inbound, missing_owner = {}, {stem: set() for stem in stems}, []
    forms = ["[[{}]]", "[[{}|see here]]", "[[{}#details]]", "[[{}#details|details]]"]
    for stem in stems:
        front = ["---", f"title: {title(stem)}"]
        if rng.random() < 0.85:
            front.append(f"owner: {rng.choice(['ana', 'bo', 'chen', 'dee', 'eli'])}")
        else:
            missing_owner.append(paths[stem])
        front.append(f"tags: [{', '.join(rng.sample(['a', 'b', 'c', 'd'], 2))}]")
        front.append("---")
        body = [f"# {title(stem)}", ""]
        size = 0
        target_size = int(rng.lognormvariate(8.3, 0.6))
        while size < target_size:
            paragraph = sentence(rng.randint(20, 40))
            if rng.random() < 0.35:
                linked = rng.choices(popular, weights)[0]
                if rng.random() < 0.03:
                    linked = f"missing-{rng.randint(0, 50)}"
                if rng.random() < 0.02:
                    linked = stem
                paragraph += " See " + rng.choice(forms).format(linked) + "."
                if linked in inbound and linked != stem:
                    inbound[linked].add(stem)
            body.append(paragraph)
            body.append("")
            size += len(paragraph) + 2
        files[paths[stem]] = "\n".join(front + body)
    orphans = sorted(paths[stem] for stem in stems if not inbound[stem])
    top = sorted(stems, key=lambda stem: (-len(inbound[stem]), stem))[:10]
    report = ["# Audit", "", "## Orphans", ""] + [f"- {p}" for p in orphans]
    report += ["", "## Most linked", ""] + [f"- {stem}: {len(inbound[stem])}" for stem in top]
    report += ["", "## Missing owner", ""] + [f"- {p}" for p in sorted(missing_owner)]
    expected = dict(files)
    expected["reports/audit.md"] = "\n".join(report) + "\n"
    return files, expected


if __name__ == "__main__":
    out = sys.argv[1]
    builds = (("s1", s1), ("s3", s3), ("s3-10k", lambda: s3(10_000)))
    for name, build in builds if len(sys.argv) < 3 else [b for b in builds if b[0] in sys.argv[2:]]:
        files, expected = build()
        json.dump({"files": files, "expected": expected}, open(f"{out}/{name}.json", "w"))
        print(name, len(files), "pages", sum(len(t) for t in files.values()), "bytes")
