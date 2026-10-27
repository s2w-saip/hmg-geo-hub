"""Every golden case recorded from the front must be rebuilt identically by the screen builders."""
import os
import unittest

try:
    from bff.tests.golden_util import case_files, run_case
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_golden)") from exc


class Golden(unittest.IsolatedAsyncioTestCase):
    async def test_cases(self):
        only = {f for f in os.environ.get("GOLDEN_ONLY", "").split(",") if f}
        files = [p for p in case_files() if not only or p.parent.name in only]
        self.assertTrue(files, "no golden cases")
        failures = {}
        for path in files:
            try:
                problems = await run_case(path)
            except Exception as exc:  # report every case, not only the first failure
                problems = [f"{type(exc).__name__}: {exc}"]
            if problems:
                failures[f"{path.parent.name}/{path.name.split('.')[0]}"] = problems[:8]
        if failures:
            lines = [f"{name}: " + " | ".join(p) for name, p in sorted(failures.items())]
            self.fail(f"{len(failures)}/{len(files)} golden cases differ:\n" + "\n".join(lines))


if __name__ == "__main__":
    unittest.main()
