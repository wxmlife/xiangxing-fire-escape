#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
用法：
  ./publish.sh [提交说明]
  ./publish.sh --dry-run

功能：运行测试，提交网站文件，推送 GitHub，并等待 GitHub Pages 部署完成。
EOF
}

dry_run=false
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi

for command_name in git gh node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少命令：$command_name" >&2
    exit 1
  fi
done

if [[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]]; then
  echo "当前目录不是 Git 仓库" >&2
  exit 1
fi

if [[ "${PUBLISH_SKIP_TESTS:-0}" != "1" ]]; then
  echo "[1/4] 运行安全与路径测试"
  node --test tests/planner.test.mjs
  node --check dist/app.js
  node --check dist/planner.mjs
  node --check dist/demo-scene.mjs
  bash -n publish.sh
  PUBLISH_SKIP_TESTS=1 bash tests/publish-script.test.sh
fi

if [[ "$dry_run" == "true" ]]; then
  echo "Dry run complete：检查通过，未修改、提交或上传任何文件。"
  exit 0
fi

if git remote get-url github >/dev/null 2>&1; then
  github_remote="github"
elif git remote get-url origin 2>/dev/null | grep -q 'github.com'; then
  github_remote="origin"
else
  echo "没有找到 GitHub 远程仓库（期望远程名 github，或指向 github.com 的 origin）" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI 尚未登录，请先运行：gh auth login" >&2
  exit 1
fi

echo "[2/4] 暂存并提交网站文件"
publish_paths=(dist tests .github README.md publish.sh .gitignore)
git add -A -- "${publish_paths[@]}"

sensitive_file=""
while IFS= read -r staged_file; do
  if [[ "$staged_file" =~ (^|/)(\.env($|\.)|[^/]*(secret|credential)[^/]*|[^/]*\.(pem|key|p12|pfx))$ ]]; then
    sensitive_file="$staged_file"
    git restore --staged -- "$staged_file"
  fi
done < <(git diff --cached --name-only)

if [[ -n "$sensitive_file" ]]; then
  echo "检测到疑似敏感文件，已取消暂存并停止发布：$sensitive_file" >&2
  exit 1
fi

if git diff --cached --quiet; then
  repo_name="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
  pages_url="$(gh api "repos/$repo_name/pages" --jq '.html_url')"
  echo "没有需要发布的网站修改。当前公开地址：$pages_url"
  exit 0
fi

commit_message="${*:-Update site $(date '+%Y-%m-%d %H:%M')}"
git commit -m "$commit_message"

echo "[3/4] 推送到 GitHub"
git push "$github_remote" HEAD:main

commit_sha="$(git rev-parse HEAD)"
run_id=""
for _ in {1..30}; do
  run_id="$(gh run list --workflow pages.yml --branch main --commit "$commit_sha" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [[ -n "$run_id" ]] && break
  sleep 2
done

if [[ -z "$run_id" ]]; then
  echo "已推送，但 60 秒内没有找到对应的 GitHub Pages 工作流" >&2
  exit 1
fi

echo "[4/4] 等待 GitHub Pages 部署完成"
gh run watch "$run_id" --exit-status --interval 3

repo_name="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
repo_url="$(gh repo view --json url --jq '.url')"
pages_url="$(gh api "repos/$repo_name/pages" --jq '.html_url')"

echo
echo "发布完成"
echo "GitHub：$repo_url"
echo "网站：$pages_url"

