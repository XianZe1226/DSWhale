import ast
import copy
from pathlib import Path
from types import SimpleNamespace

import pytest


def helpers():
    from astrbot.core.config.default import CONFIG_METADATA_2

    from dswhale.provider_compat import ensure_provider_categories

    return ensure_provider_categories, CONFIG_METADATA_2["provider_group"]["metadata"]["provider"][
        "config_template"
    ]


def pinned_function(name):
    import astrbot

    file = Path(astrbot.__file__).parent / "core/utils/migra_helper.py"
    tree = ast.parse(file.read_text(encoding="utf-8"))
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    namespace = {"Any": object, "logger": SimpleNamespace(info=lambda *a: None)}
    exec(
        compile(ast.Module(body=[node], type_ignores=[]), "<pinned-public-migration>", "exec"),
        namespace,
    )
    return namespace[name]


class Config(dict):
    def save_config(self):
        pass


@pytest.mark.parametrize("kind", ["openai_responses", "minimax_token_plan", "xiaomi_token_plan"])
def test_missing_known_source_category_is_repaired_without_changing_connections(kind):
    repair, templates = helpers()
    source = {
        "id": "source-test",
        "type": kind,
        "key": ["SYNTHETIC-KEY"],
        "api_base": "https://example.invalid",
        "custom": {"keep": True},
    }
    config = {
        "provider_sources": [copy.deepcopy(source)],
        "provider": [
            {"id": "model-test", "provider_source_id": "source-test", "model": "chosen-model"}
        ],
    }
    before = copy.deepcopy(config)
    assert repair(config, templates) == 1
    assert config["provider_sources"][0] == {**source, "provider_type": "chat_completion"}
    assert config["provider"] == before["provider"]
    assert repair(config, templates) == 0


def test_unknown_types_existing_categories_and_ambiguous_templates_are_untouched():
    repair, templates = helpers()
    config = {
        "provider_sources": [
            {"id": "unknown", "type": "custom_adapter", "key": ["SYNTHETIC"]},
            {"id": "existing", "type": "openai_responses", "provider_type": "user_custom"},
        ],
        "provider": [],
    }
    before = copy.deepcopy(config)
    assert repair(config, templates) == 0
    assert config == before
    ambiguous = {
        "one": {"type": "test", "provider_type": "chat_completion"},
        "two": {"type": "test", "provider_type": "embedding"},
    }
    config = {"provider_sources": [{"id": "x", "type": "test"}]}
    before = copy.deepcopy(config)
    assert repair(config, ambiguous) == 0
    assert config == before


def test_repeated_bootstrap_and_real_upstream_migration_keep_models_keys_defaults_and_memory(
    tmp_path,
):
    import json
    import os
    import sys

    from scripts.bootstrap import initialize_host_config

    repair, templates = helpers()
    migrate = pinned_function("_migra_provider_to_source_structure")
    host = tmp_path / "host"
    (host / "data").mkdir(parents=True)
    memory = host / "data/memory.bin"
    memory.write_bytes(b"SYNTHETIC-MEMORY")
    config = Config(
        {
            "provider_sources": [],
            "provider": [
                {
                    "id": "legacy-model",
                    "type": "openai_responses",
                    "key": ["SYNTHETIC-KEY"],
                    "api_base": "https://example.invalid",
                    "model_config": {"model": "chosen-model", "max_tokens": 2048},
                }
            ],
            "agent_runner": {"config": {"model": {"provider_id": "legacy-model"}}},
            "provider_settings": {"embedding_provider_id": "embedding-test"},
        }
    )
    file = host / "data/cmd_config.json"
    file.write_text(json.dumps(config))
    for _ in range(5):
        initialize_host_config(
            host,
            sys.executable,
            {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1])},
            desktop=True,
        )
        config = Config(json.loads(file.read_text()))
        migrate(config)
        file.write_text(json.dumps(config))
        assert config["provider"][0]["id"] == "legacy-model"
        assert config["provider"][0]["provider_source_id"] == "legacy-model_source"
        assert config["provider"][0]["model"] == "chosen-model"
        source = config["provider_sources"][0]
        assert (
            source["key"] == ["SYNTHETIC-KEY"] and source["api_base"] == "https://example.invalid"
        )
        assert source["provider_type"] == "chat_completion"
        assert config["agent_runner"]["config"]["model"]["provider_id"] == "legacy-model"
        assert config["provider_settings"]["embedding_provider_id"] == "embedding-test"
        assert memory.read_bytes() == b"SYNTHETIC-MEMORY"
        assert repair(config, templates) == 0


@pytest.mark.parametrize(
    "change,collision",
    [
        ({}, True),
        ({"id": "duplicate"}, False),
        ({"custom_extra_body": None}, False),
        ({"custom_extra_body": []}, False),
    ],
)
def test_unsafe_legacy_conversion_is_not_enabled(change, collision):
    repair, templates = helpers()
    provider = {
        "id": "legacy",
        "type": "openai_responses",
        "model_config": {"model": "test", "extra": True},
        **change,
    }
    config = {
        "provider_sources": [{"id": "legacy_source", "type": "custom"}] if collision else [],
        "provider": [provider, {"id": "duplicate", "provider_source_id": "missing"}],
    }
    before = copy.deepcopy(config)
    assert repair(config, templates) == 0
    assert config == before


def test_literal_sdk_category_projection_matches_runtime_templates():
    from dswhale.provider_compat import provider_templates

    _, templates = helpers()
    expected = {
        key: {f: value[f] for f in ("type", "provider_type")}
        for key, value in templates.items()
        if all(isinstance(value.get(f), str) for f in ("type", "provider_type"))
    }
    assert provider_templates() == expected
