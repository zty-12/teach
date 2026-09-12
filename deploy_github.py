#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
edu-workbench → GitHub 仓库 zty-12/teach 部署脚本
  - main 分支：源码
  - gh-pages 分支：构建产物（GitHub Pages 部署源）
  - 并自动调用 REST API 启用 GitHub Pages

用法：
  python deploy_github.py <GitHub Personal Access Token>
  或设置环境变量 GITHUB_TOKEN 后直接运行

Token 要求：
  classic token 勾选 repo；
  或 fine-grained token 授予 Contents / Pages / Administration 的读写权限。

凭据仅通过 GIT_CONFIG_* 环境变量与 HTTPS 头传递，不写入 .git/config，不落盘。
"""
import io
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

OWNER = "zty-12"
REPO = "teach"
REPO_URL = f"https://github.com/{OWNER}/{REPO}.git"
PROJECT = r"D:\wbdata\edu-workbench"
PAGES_URL = f"https://{OWNER}.github.io/{REPO}/"


def get_token() -> str:
    if len(sys.argv) > 1 and sys.argv[1].strip():
        return sys.argv[1].strip()
    t = os.environ.get("GITHUB_TOKEN", "").strip()
    if t:
        return t
    raise SystemExit(
        "缺少 GitHub Token。用法：python deploy_github.py <token>，或设置 GITHUB_TOKEN 环境变量。"
    )


def run(args, cwd=PROJECT, env=None, check=True):
    proc = subprocess.run(
        args, cwd=cwd, env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if check and proc.returncode != 0:
        print(f"  [FAIL] {' '.join(args[:4])}")
        print("  stdout:", proc.stdout[-800:])
        print("  stderr:", proc.stderr[-800:])
        raise SystemExit(1)
    return proc


def git_env(token: str):
    """构造带鉴权头的 git 环境（不在 .git/config 留痕）"""
    env = dict(os.environ)
    env["GIT_CONFIG_COUNT"] = "1"
    env["GIT_CONFIG_KEY_0"] = "http.extraheader"
    env["GIT_CONFIG_VALUE_0"] = f"Authorization: Bearer {token}"
    env["GIT_AUTHOR_NAME"] = OWNER
    env["GIT_AUTHOR_EMAIL"] = f"{OWNER}@users.noreply.github.com"
    env["GIT_COMMITTER_NAME"] = OWNER
    env["GIT_COMMITTER_EMAIL"] = f"{OWNER}@users.noreply.github.com"
    return env


def api(method: str, path: str, token: str, payload=None):
    url = f"https://api.github.com{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "edu-workbench-deploy",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, {"message": body[:200]}


def push_source(token: str):
    env = git_env(token)
    print("=== 1) 本地仓库 ===")
    if not os.path.exists(os.path.join(PROJECT, ".git")):
        run(["git", "init", "-q"], env=env)
    run(["git", "symbolic-ref", "HEAD", "refs/heads/main"], env=env)

    print("=== 2) 提交源码 ===")
    run(["git", "add", "-A"], env=env)
    staged = run(["git", "diff", "--cached", "--name-only"], env=env).stdout.split()
    print(f"  暂存 {len(staged)} 个文件")
    has_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=PROJECT, env=env, capture_output=True
    ).returncode == 0
    if staged or not has_commit:
        run(["git", "commit", "-q", "-m",
             "feat: 教务工作台 v13（结构化反馈模板 + 班课打卡配置 + 全页并发识别）"],
            env=env)
        print("  已提交")
    else:
        print("  无变更，跳过")

    print("=== 3) 推送 main ===")
    run(["git", "remote", "remove", "origin"], env=env, check=False)
    run(["git", "remote", "add", "origin", REPO_URL], env=env)
    out = run(["git", "push", "-u", "origin", "main"], env=env, check=False)
    if out.returncode != 0:
        print("  stdout:", out.stdout[-600:])
        print("  stderr:", out.stderr[-600:])
        raise SystemExit("main 推送失败（检查 Token 是否勾选 repo 权限）")
    print("  ✓ main 已推送")


def push_pages(token: str):
    env = git_env(token)
    print("=== 4) 准备 gh-pages 产物 ===")
    deploy_dir = os.path.join(os.environ.get("TEMP", "/tmp"), "teach-ghpages")
    if os.path.exists(deploy_dir):
        shutil.rmtree(deploy_dir, ignore_errors=True)
    os.makedirs(deploy_dir)
    src_dist = os.path.join(PROJECT, "dist")
    if not os.path.isdir(src_dist):
        raise SystemExit("dist 不存在，请先执行 npm run build")
    for name in os.listdir(src_dist):
        s, d = os.path.join(src_dist, name), os.path.join(deploy_dir, name)
        shutil.copytree(s, d) if os.path.isdir(s) else shutil.copy2(s, d)
    # 禁用 Jekyll，防止 Pages 忽略部分静态资源
    io.open(os.path.join(deploy_dir, ".nojekyll"), "w", encoding="utf-8").write("")
    files = sum(len(f) for _, _, f in os.walk(deploy_dir))
    print(f"  产物 {files} 个文件")

    print("=== 5) 推送 gh-pages ===")
    run(["git", "init", "-q"], cwd=deploy_dir, env=env)
    run(["git", "symbolic-ref", "HEAD", "refs/heads/gh-pages"], cwd=deploy_dir, env=env)
    run(["git", "add", "-A"], cwd=deploy_dir, env=env)
    run(["git", "commit", "-q", "-m", "deploy: 构建产物 (base=/teach/)"],
        cwd=deploy_dir, env=env)
    run(["git", "remote", "remove", "origin"], cwd=deploy_dir, env=env, check=False)
    run(["git", "remote", "add", "origin", REPO_URL], cwd=deploy_dir, env=env)
    out = run(["git", "push", "-f", "origin", "gh-pages"], cwd=deploy_dir, env=env,
              check=False)
    if out.returncode != 0:
        print("  stdout:", out.stdout[-600:])
        print("  stderr:", out.stderr[-600:])
        raise SystemExit("gh-pages 推送失败")
    print("  ✓ gh-pages 已推送")
    shutil.rmtree(deploy_dir, ignore_errors=True)


def enable_pages(token: str):
    print("=== 6) 启用 GitHub Pages ===")
    status, info = api("GET", f"/repos/{OWNER}/{REPO}/pages", token)
    if status == 200:
        src = (info.get("source") or {})
        print(f"  Pages 已启用，当前源: {src.get('branch')}/{src.get('path')}")
        if src.get("branch") != "gh-pages":
            print("  切换到 gh-pages 分支…")
            st2, _ = api("PUT", f"/repos/{OWNER}/{REPO}/pages", token,
                         {"source": {"branch": "gh-pages", "path": "/"}})
            print(f"  切换结果: HTTP {st2}")
        return
    if status == 404:
        st2, body = api("POST", f"/repos/{OWNER}/{REPO}/pages", token,
                        {"source": {"branch": "gh-pages", "path": "/"}})
        print(f"  启用结果: HTTP {st2} {body.get('message', '')}")
        if st2 >= 400:
            print("  ⚠ 自动启用失败，请在网页端 Settings → Pages 手动选择 gh-pages 分支")
        return
    print(f"  查询 Pages 状态异常: HTTP {status} {str(info)[:200]}")


def main():
    token = get_token()
    push_source(token)
    push_pages(token)
    enable_pages(token)
    print("\n" + "=" * 50)
    print("完成！")
    print(f"  源码仓库: https://github.com/{OWNER}/{REPO}/tree/main")
    print(f"  在线站点: {PAGES_URL}")
    print("  首次部署 Pages 需 1~3 分钟构建，稍后刷新即可访问。")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if isinstance(e.code, str):
            print("ERROR:", e.code)
        sys.exit(1)
