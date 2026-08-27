"""workflow 编排脚本 analyze-commits-v6.js 的边界用例,经 node harness 执行。

harness 见 scripts/workflows/selftest.mjs:用 AsyncFunction 注入 workflow runtime 的
agent/parallel/phase/log/args,模拟 agent 失败返回 null、捏造 finding_id、缺字段等边界。
"""
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


class AnalyzeCommitsV6BoundaryTest(unittest.TestCase):
    def test_boundary_cases(self):
        proc = subprocess.run(
            ["node", "scripts/workflows/selftest.mjs"],
            cwd=REPO,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"selftest 失败:\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}",
        )
        self.assertIn("ALL PASSED", proc.stdout)


if __name__ == "__main__":
    unittest.main()
