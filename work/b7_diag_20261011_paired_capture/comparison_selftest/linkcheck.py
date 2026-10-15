import pathlib, re, sys

ROOT = pathlib.Path(r'E:\My Local AI\work\b7_diag_20261011_paired_capture')
REPORT = ROOT / 'phase20_report_harness_safety_review.md'
txt = REPORT.read_text(encoding='utf-8')
links = re.findall(r'\[([^\]]+)\]\(([^)]+)\)', txt)
print('total links:', len(links))
bad = []
for label, target in links:
    t = target
    if t.startswith('http') or t.startswith('mailto'):
        continue
    if t.startswith('#'):
        anchor = t.lstrip('#')
        anchor = re.sub(r'[^a-z0-9_-]+', '-', anchor.strip().lower())
        path = REPORT
    else:
        if '#' in t:
            path_s, _, anchor = t.partition('#')
        else:
            path_s, anchor = t, None
        p = pathlib.Path(path_s)
        if not p.is_absolute():
            p = ROOT / p
        path = p.resolve()
        if not path.exists():
            # Try CWD-relative resolution as a fallback for paths that are
            # already absolute in git's forward-slash form.
            p2 = pathlib.Path(path_s).resolve()
            if p2.exists():
                path = p2
        path = p
        if not anchor:
            anchor = None
        else:
            anchor = anchor.strip()
    if not path.exists():
        bad.append((label, target, 'missing'))
    elif anchor:
        try:
            content = path.read_text(encoding='utf-8', errors='replace')
            heading_pat = re.compile(r'^#{1,6}\s+.*' + re.escape(anchor), re.M)
            inline_pat = re.compile(r'\b' + re.escape(anchor) + r'\b')
            if not heading_pat.search(content) and not inline_pat.search(content):
                bad.append((label, target, f'anchor {anchor!r} not found'))
        except Exception as e:
            bad.append((label, target, f'read-error {e}'))
print('broken:', bad[:20])
if bad:
    sys.exit(1)
