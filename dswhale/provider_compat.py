"""Conservative offline repair of known AstrBot provider category metadata."""

import ast
import json
from collections import Counter
from importlib.util import find_spec
from pathlib import Path


def provider_templates():
    # Importing astrbot.core initializes and migrates cwd/data. Read only the
    # literal category fields from the installed, pinned SDK instead.
    spec = find_spec("astrbot")
    tree = ast.parse(
        (Path(spec.origin).parent / "core/config/default.py").read_text(encoding="utf-8")
    )
    node = next(
        n.value
        for n in tree.body
        if isinstance(n, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == "CONFIG_METADATA_2" for t in n.targets)
    )
    for key in ("provider_group", "metadata", "provider", "config_template"):
        node = next(
            v
            for k, v in zip(node.keys, node.values, strict=True)
            if isinstance(k, ast.Constant) and k.value == key
        )
    result = {}
    for name, template in zip(node.keys, node.values, strict=True):
        fields = {
            k.value: v.value
            for k, v in zip(template.keys, template.values, strict=True)
            if isinstance(k, ast.Constant)
            and k.value in {"type", "provider_type"}
            and isinstance(v, ast.Constant)
            and isinstance(v.value, str)
        }
        if isinstance(name, ast.Constant) and set(fields) == {"type", "provider_type"}:
            result[name.value] = fields
    return result


def repair_host_providers(host):
    file = Path(host) / "data/cmd_config.json"
    config = json.loads(file.read_text(encoding="utf-8-sig"))
    if ensure_provider_categories(config, provider_templates()):
        temporary = file.with_suffix(".providers.tmp")
        try:
            temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.chmod(0o600)
            temporary.replace(file)
        finally:
            temporary.unlink(missing_ok=True)


def ensure_provider_categories(config, templates):
    """Fill missing categories from exact upstream templates, never credentials.

    Legacy inline records are left to AstrBot's own migration. Do not enable
    that migration when its generated source ID or extra-body merge is unsafe.
    Unknown adapters and explicit existing metadata remain unchanged.
    """
    if not isinstance(config, dict) or not isinstance(templates, dict):
        return 0
    known = {}
    for template in templates.values():
        if not isinstance(template, dict):
            continue
        kind, category = template.get("type"), template.get("provider_type")
        if isinstance(kind, str) and isinstance(category, str) and category:
            known.setdefault(kind, set()).add(category)
    sources, models = config.get("provider_sources", []), config.get("provider", [])
    if not isinstance(sources, list) or not isinstance(models, list):
        return 0
    source_ids = {
        s.get("id") for s in sources if isinstance(s, dict) and isinstance(s.get("id"), str)
    }
    counts = Counter(
        p.get("id") for p in models if isinstance(p, dict) and isinstance(p.get("id"), str)
    )
    changed = 0
    for record, inline in [(s, False) for s in sources] + [(p, True) for p in models]:
        if not isinstance(record, dict) or record.get("provider_type") not in (None, ""):
            continue
        kind = record.get("type")
        categories = known.get(kind, set()) if isinstance(kind, str) else set()
        if len(categories) != 1:
            continue
        category = next(iter(categories))
        if inline:
            model_id = record.get("id")
            if record.get("provider_source_id") or category != "chat_completion":
                continue
            if (
                not isinstance(model_id, str)
                or not model_id
                or counts[model_id] != 1
                or model_id + "_source" in source_ids
            ):
                continue
            extra = record.get("model_config")
            if (
                isinstance(extra, dict)
                and any(k != "model" for k in extra)
                and "custom_extra_body" in record
                and not isinstance(record["custom_extra_body"], dict)
            ):
                continue
            source_ids.add(model_id + "_source")
        record["provider_type"] = category
        changed += 1
    return changed
