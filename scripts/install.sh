#!/bin/sh
# Session Steward 一行安装（macOS，未签名的预编译版本）：
#   curl -fsSL https://raw.githubusercontent.com/xoqiu09/session-steward/main/scripts/install.sh | sh
#   … | sh -s -- --setup            装好后接着询问是否装 hooks 和开机自启
#   … | sh -s -- --version v0.3.0   指定版本；--dir DIR 指定安装位置
# 只下载 GitHub Release 里的文件并校验 SHA256；不改任何配置，除非加 --setup 并逐项确认。
# 测试用：STEWARD_INSTALL_SOURCE=<含 tar.gz 和 SHA256SUMS 的本地目录>。
set -eu
REPO=xoqiu09/session-steward
version=""
dir="$HOME/.local/share/session-steward"
setup=0
while [ $# -gt 0 ]; do
	case "$1" in
	--version) version=${2:?}; shift 2 ;;
	--dir) dir=${2:?}; shift 2 ;;
	--setup) setup=1; shift ;;
	*) echo "不认识的参数：$1" >&2; exit 2 ;;
	esac
done
die() { echo "错误：$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die "目前只提供 macOS 预编译版本；其他系统请按 README 从源码构建。"
case "$(uname -m)" in
arm64) arch=arm64 ;;
x86_64) arch=amd64 ;;
*) die "不支持的处理器：$(uname -m)" ;;
esac
case "$dir" in
"$HOME/Documents"* | "$HOME/Desktop"* | "$HOME/Downloads"*)
	echo "提醒：$dir 在系统受保护的文件夹里，后台服务首次启动可能卡住。建议用默认位置。" >&2 ;;
esac

src=${STEWARD_INSTALL_SOURCE:-}
if [ -z "$version" ]; then
	if [ -n "$src" ]; then
		version=$(ls "$src" | sed -n 's/^session-steward_\(.*\)_darwin_.*\.tar\.gz$/\1/p' | head -1)
	else
		version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
	fi
	[ -n "$version" ] || die "找不到可用的版本（GitHub 上还没有正式发布？）"
fi
name="session-steward_${version}_darwin_${arch}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch() {
	if [ -n "$src" ]; then cp "$src/$1" "$tmp/$1"
	else curl -fsSL -o "$tmp/$1" "https://github.com/$REPO/releases/download/$version/$1"; fi
}
echo "下载 Session Steward $version（$arch）…"
fetch "$name.tar.gz" || die "下载 $name.tar.gz 失败"
fetch SHA256SUMS || die "下载 SHA256SUMS 失败"
want=$(awk -v f="$name.tar.gz" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
got=$(shasum -a 256 "$tmp/$name.tar.gz" | awk '{ print $1 }')
[ -n "$want" ] && [ "$want" = "$got" ] || die "校验失败：文件和 SHA256SUMS 对不上，已停止。"

mkdir -p "$dir/versions"
rm -rf "$dir/versions/$name"
tar -xzf "$tmp/$name.tar.gz" -C "$dir/versions"
ln -sfn "versions/$name" "$dir/current"
bin="$dir/current/steward"
echo "已安装到 $dir/current（$("$bin" version)）"

ask() {
	[ -r /dev/tty ] || return 1
	printf '%s [y/N] ' "$1" > /dev/tty
	read -r a < /dev/tty || return 1
	[ "$a" = y ] || [ "$a" = Y ]
}
if [ "$setup" = 1 ]; then
	echo
	echo "下一步会给 Claude Code / Codex 加 hooks：只在 ~/.claude/settings.json 和 ~/.codex/hooks.json 里追加 Steward 自己的条目，改之前先备份；以后可用 steward uninstall 去掉。"
	if ask "现在安装 hooks？"; then "$bin" install; else echo "跳过 hooks。"; fi
	echo
	echo "开机自启：登录后由 launchd 在后台运行，只监听 127.0.0.1:7788。若别处已经装过 steward service，请先在那边运行 steward service uninstall。"
	if ask "现在设为开机自启并启动？"; then "$bin" service install && "$bin" open || true; else echo "跳过开机自启。"; fi
else
	cat <<TXT

接下来（在终端里）：
  $bin install           # 给 Claude Code / Codex 加 hooks（可用 steward uninstall 去掉）
  $bin service install   # 登录后自动启动，后台常驻 127.0.0.1:7788
  $bin open              # 打开面板
或者重新运行本脚本并加 --setup，逐项确认。
TXT
fi
