#!/usr/bin/env python3
"""Exercise the installer with local release fixtures and no network access."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().with_name("setup-cli.sh")


class SetupCLI(unittest.TestCase):
    def install(self, platform="Linux", arch="X64", version="v0.1.0", checksum="valid", missing=False):
        with tempfile.TemporaryDirectory(prefix="maven r2 test ") as root:
            root = Path(root)
            tools = root / "tools"
            tools.mkdir()
            # Stand in for GitHub downloads, preserving real checksum verification.
            (tools / "curl").write_text('''#!/usr/bin/env bash
set -eu
url="${@: -3:1}"
output="${@: -1}"
if [[ "$url" == */SHA256SUMS ]]; then
    cp "$FIXTURE/SHA256SUMS" "$output"
else
    cp "$FIXTURE/binary" "$output"
fi
''')
            (tools / "cygpath").write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$2"\n')
            for tool in tools.iterdir():
                tool.chmod(0o755)
            binary = b"fixture CLI bytes\n"
            (root / "binary").write_bytes(binary)
            os_name = {"Linux": "linux", "macOS": "darwin", "Windows": "windows"}.get(platform, "unknown")
            cpu = {"X64": "amd64", "ARM64": "arm64"}.get(arch, "unknown")
            suffix = ".exe" if platform == "Windows" else ""
            asset = f"maven-r2-{os_name}-{cpu}{suffix}"
            digest = hashlib.sha256(binary).hexdigest() if checksum == "valid" else "0" * 64
            (root / "SHA256SUMS").write_text("" if missing else f"{digest}  {asset}\n")
            path_file = root / "path"
            env = {**os.environ, "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}",
                   "FIXTURE": str(root), "RUNNER_TEMP": str(root), "GITHUB_PATH": str(path_file),
                   "MAVEN_R2_VERSION": version, "RUNNER_OS": platform, "RUNNER_ARCH": arch}
            result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)
            if result.returncode == 0:
                installed = Path(path_file.read_text().strip()) / f"maven-r2{suffix}"
                self.assertEqual(installed.read_bytes(), binary)
                self.assertTrue(os.access(installed, os.X_OK))
            else:
                self.assertFalse(path_file.exists())
                self.assertEqual(list(root.glob("maven-r2.*")), [])
            return result

    def test_supported_targets(self):
        for platform in ("Linux", "macOS", "Windows"):
            for arch in ("X64", "ARM64"):
                with self.subTest(platform=platform, arch=arch):
                    result = self.install(platform=platform, arch=arch)
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_bad_inputs_and_downloads(self):
        for options in ({"version": ""}, {"version": "../../main"}, {"version": "$(echo bad)"},
                        {"platform": "FreeBSD"}, {"arch": "ARM"}, {"checksum": "bad"}, {"missing": True}):
            with self.subTest(options=options):
                self.assertNotEqual(self.install(**options).returncode, 0)


if __name__ == "__main__":
    unittest.main()
