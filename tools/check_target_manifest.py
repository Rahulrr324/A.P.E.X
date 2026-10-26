#!/usr/bin/env python3
"""Check reviewed compiler manifest against this repository's simple CMake subset.

This is a drift detector, NOT a CMake interpreter/configure check. It deliberately
rejects unknown target variables or library expressions rather than guessing.
Platform skip metadata remains a separately reviewed contract.
"""
import json
from pathlib import Path
import re
import sys


def expand(tokens, variables):
    result = []
    for token in tokens:
        if token.startswith("${") and token.endswith("}"):
            name = token[2:-1]
            if name not in variables:
                raise ValueError("unknown source variable " + name)
            result.extend(variables[name])
        elif "$" in token:
            raise ValueError("unsupported CMake expression " + token)
        else:
            result.append(token)
    return result


def declared_sources(text):
    text = re.sub(r"#[^\n]*", "", text)
    variables = {m[0]: m[1].split() for m in re.findall(r"\bset\((\w+)\s+([^)]*)\)", text)}
    loops = [(m.start(), m.end(), m.group(1).split()) for m in
             re.finditer(r"foreach\(t\s+([^)]*)\)(.*?)endforeach\(\)", text, re.S)]
    libraries = {}
    for name, body in re.findall(r"add_library\((\S+)\s+STATIC\s+([^)]*)\)", text):
        libraries[name] = [s for s in expand(body.split(), variables) if s.endswith(".cpp")]
    links = {name: body.split() for name, body in re.findall(r"target_link_libraries\((\S+)\s+(?:PRIVATE|PUBLIC|INTERFACE)\s+([^)]*)\)", text)}
    targets = {}
    for m in re.finditer(r"add_executable\((\S+)\s+([^)]*)\)", text):
        name, body = m.group(1), m.group(2)
        values = [None]
        if "${t}" in name:
            enclosures = [v for start, end, v in loops if start <= m.start() < end]
            if len(enclosures) != 1:
                raise ValueError("unsupported foreach target context")
            values = enclosures[0]
        for value in values:
            replace = lambda s: s.replace("${t}", value) if value is not None else s
            resolved = replace(name)
            if resolved in targets:
                raise ValueError("duplicate executable " + resolved)
            sources = [s for s in expand(replace(body).split(), variables) if s.endswith(".cpp")]
            for linked in links.get(name, []):
                linked = replace(linked)
                if "$" in linked:
                    raise ValueError("unsupported link expression")
                sources.extend(libraries.get(linked, []))
            targets[resolved] = sorted(sources)
    return targets


def check(source):
    manifest = json.loads((source / "tools/targets.json").read_text())
    actual = declared_sources((source / "stark/CMakeLists.txt").read_text())
    expected = {t["name"]: sorted(t["sources"]) for t in manifest["targets"]}
    if len(expected) != len(manifest["targets"]):
        raise ValueError("duplicate manifest target")
    if set(actual) != set(expected):
        raise ValueError("target name drift: " + repr(sorted(set(actual) ^ set(expected))))
    for name in expected:
        if expected[name] != actual[name]:
            raise ValueError("source-list drift: " + name)
    return len(actual)


def main():
    try:
        count = check(Path(__file__).resolve().parents[1])
    except (ValueError, KeyError, OSError) as e:
        print("manifest drift check FAIL:", e, file=sys.stderr)
        return 1
    print(f"manifest source-list drift check PASS: {count} executables (not CMake evaluation)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
