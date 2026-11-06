"""What the stand-in connections of the reader tests leave out: what metrics.gold_judged reads once per set of builds or per read (the judged
populations, the answers' keys, the input store)."""
import unittest
from unittest import mock

from bff.metrics.gold_judged import CitationKeys, Inputs, MentionKeys, Populations

NO_MENTION_KEYS = MentionKeys(*([] for _ in MentionKeys._fields))
NO_CITATION_KEYS = CitationKeys([], [])


def no_judged_answers() -> None:
    """For setUpModule: every answer in every population, nothing registered, no read for any of it."""
    for target, value in (("bff.gold_reader.context.populations", Populations()),
                          ("bff.metrics.gold_judged.owned_url_keys", []),
                          ("bff.metrics.gold_judged.read_inputs", Inputs()),
                          ("bff.metrics.serving.read_inputs", Inputs()),
                          ("bff.metrics.gold_current.mention_keys", NO_MENTION_KEYS),
                          ("bff.gold_reader.drilldown.mention_keys", NO_MENTION_KEYS),
                          ("bff.gold_reader.answers.mention_keys", NO_MENTION_KEYS),
                          ("bff.gold_reader.answers.citation_keys", NO_CITATION_KEYS)):
        patcher = mock.patch(target, mock.AsyncMock(return_value=value))
        patcher.start()
        unittest.addModuleCleanup(patcher.stop)
