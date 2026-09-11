#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 edu-workbench 推送到 GitHub 仓库 zty-12/teach：
  - main 分支：源码
  - gh-pages 分支：构建产物（供 GitHub Pages 部署）

凭据从环境变量 CODEBUDDY_MCP_CONFIG 里的 github server 配置读取，
仅用于本次 git push（通过 http.extraheader 传递，不写入 .git/config）。
"""
import io
import json
import os
import shutil
import subprocess
import sys

OWNER = "zty-12"
REPO = "teach"
REPO_URL = f"https://github.com/{OWNER}/{REPO}.git"
PROJECT = r"D:\wbdata\edu-workbench"


def get_token() -> str:
    raw = os.environ.get("CODEBUDDY_MCP_CONFIG", "")
    if not raw:
        raise SystemExit("未找到 CODEBUDDY_MCP_CONFIG")
    cfg = json.loads(raw)
    auth = cfg["mcpServers"]["github"]["headers"]["Authorization"]
    if not auth.lower().startswith("bearer "):
        raise SystemExit("Authorization 格式不是 Bearer")
    return auth.split(" ", 1)[1].strip()


def run(args, cwd=PROJECT, env=None, check=True):
    proc = subprocess.run(
        args, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8",
        errors="replace",
    )
    if check and proc.returncode != 0:
        print(f"  [FAIL] {' '.join(args[:3])}")
        print("  stdout:", proc.stdout[-800:])
        print("  stderr:", proc.stderr[-800:])
        raise SystemExit(1)
    return proc


def auth_env(token: str):
    """构造带 Authorization 头且不落盘 git 配置的环境"""
    env = dict(os.environ)
    env["GIT_CONFIG_COUNT"] = "1"
    env["GIT_CONFIG_KEY_0"] = "http.extraheader"
    # git 配置值里的换行要转义
    env["GIT_CONFIG_VALUE_0"] = f"Authorization: Bearer {token}".replace("\n", "\\n")
    return env


def git_identity_env(token: str):
    env = auth_env(token)
    env["GIT_AUTHOR_NAME"] = "zty-12"
    env["GIT_AUTHOR_EMAIL"] = "zty-12@users.noreply.github.com"
    env["GIT_COMMITTER_NAME"] = "zty-12"
    env["GIT_COMMITTER_EMAIL"] = "zty-12@users.noreply.github.com"
    return env


def main():
    token = get_token()
    env = git_identity_env(token)

    print("=== 1) 初始化本地仓库 ===")
    if not os.path.exists(os.path.join(PROJECT, ".git")):
        run(["git", "init", "-q"], env=env)
    run(["git", "symbolic-ref", "HEAD", "refs/heads/main"], env=env)

    print("=== 2) 暂存并提交源码 ===")
    run(["git", "add", "-A"], env=env)
    staged = run(["git", "diff", "--cached", "--name-only"], env=env).stdout.split()
    print(f"  暂存文件数: {len(staged)}")

    # 已有提交则跳过空提交
    has_commit = (
        subprocess.run(["git", "rev-parse", "HEAD"], cwd=PROJECT, env=env,
                       capture_output=True).returncode == 0
    )
    if staged or not has_commit:
        run(
            ["git", "commit", "-q", "-m",
             "feat: 教务工作台 v13（结构化反馈模板 + 班课打卡配置 + 全页并发识别）"],
            env=env,
        )
        print("  提交完成")
    else:
        print("  无变更，跳过提交")

    print(f"=== 3) 推送 main 到 {REPO_URL} ===")
    run(["git", "remote", "remove", "origin"], env=env, check=False)
    run(["git", "remote", "add", "origin", REPO_URL], env=env)
    out = run(["git", "push", "-u", "origin", "main"], env=env, check=False)
    if out.returncode != 0:
        print("  stdout:", out.stdout[-900:])
        print("  stderr:", out.stderr[-900:])
        raise SystemExit("main 推送失败")
    print("  main 推送成功")
    print("   ", out.stderr.strip().splitlines()[-1] if out.stderr.strip() else "")

    print("=== 4) 准备 gh-pages 产物目录 ===")
    deploy_dir = os.path.join(os.environ.get("TEMP", "/tmp"), "teach-ghpages")
    if os.path.exists(deploy_dir):
        shutil.rmtree(deploy_dir)
    os.makedirs(deploy_dir)
    src_dist = os.path.join(PROJECT, "dist")
    for name in os.listdir(src_dist):
        s = os.path.join(src_dist, name)
        d = os.path.join(deploy_dir, name)
        shutil.copytree(s, d) if os.path.isdir(s) else shutil.copy2(s, d)
    # 禁用 Jekyll，避免 Pages 忽略部分静态资源
    io.open(os.path.join(deploy_dir, ".nojekyll"), "w", encoding="utf-8").write("")
    files = sum(len(f) for _, _, f in os.walk(deploy_dir))
    print(f"  产物文件数: {files}")

    print("=== 5) 推送 gh-pages 分支 ===")
    run(["git", "init", "-q"], cwd=deploy_dir, env=env)
    run(["git", "symbolic-ref", "HEAD", "refs/heads/gh-pages"], cwd=deploy_dir, env=env)
    run(["git", "add", "-A"], cwd=deploy_dir, env=env)
    run(["git", "commit", "-q", "-m", "deploy: 构建产物（base=/teach/）"],
        cwd=deploy_dir, env=env)
    run(["git", "remote", "remove", "origin"], cwd=deploy_dir, env=env, check=False)
    run(["git", "remote", "add", "origin", REPO_URL], cwd=deploy_dir, env=env)
    out = run(["git", "push", "-f", "origin", "gh-pages"], cwd=deploy_dir, env=env,
              check=False)
    if out.returncode != 0:
        print("  stdout:", out.stdout[-900:])
        print("  stderr:", out.stderr[-900:])
        raise SystemExit("gh-pages 推送失败")
    print("  gh-pages 推送成功")
    print("   ", out.stderr.strip().splitlines()[-1] if out.stderr.strip() else "")

    shutil.rmtree(deploy_dir, ignore_errors=True)
    print("\n=== 完成 ===")
    print(f"源码: https://github.com/{OWNER}/{REPO}/tree/main")
    print(f"产物: https://github.com/{OWNER}/{REPO}/tree/gh-pages")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if isinstance(e.code, str):
            print("ERROR:", e.code)
        sys.exit(1)
