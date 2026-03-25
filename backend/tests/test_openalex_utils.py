import demo_openai_compatible_httpx as demo


def test_reconstruct_abstract_simple():
    inverted = {"Hello": [0], "world": [1]}
    assert demo._reconstruct_abstract(inverted) == "Hello world"


def test_reconstruct_abstract_with_gaps():
    inverted = {"First": [0], "third": [2], "second": [1]}
    assert demo._reconstruct_abstract(inverted) == "First second third"


def test_parse_openalex_work_minimal():
    work = {
        "title": "Test Paper",
        "publication_year": 2024,
        "authorships": [{"author": {"display_name": "Alice"}}],
        "doi": "10.1000/test",
        "abstract_inverted_index": {"Test": [0], "abstract": [1]},
        "best_oa_location": {"landing_page_url": "https://example.com"},
    }
    parsed = demo._parse_openalex_work(work)
    assert parsed["title"] == "Test Paper"
    assert parsed["authors"] == "Alice"
    assert parsed["year"] == 2024
    assert parsed["doi"] == "10.1000/test"
    assert parsed["abstract"] == "Test abstract"
    assert parsed["oa_url"] == "https://example.com"
