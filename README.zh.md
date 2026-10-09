# dsh-session-admin

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）里的会话彻底删掉。

dsh 自带的「归档」只是把会话从侧边栏藏起来，磁盘上的东西一个字节都没少。这个插件做的是
另一件事：删掉会话的追加式日志、投影缓存、工作区登记和归档标记。删完就没了，不能恢复。

## 环境要求

Node 22.19 及以上（引擎用到内置的 Zstandard API 和 `node --test`），以及一份
`sessions`/`storages` 布局与 `@deepseek-ai/dsh-session-persistence-jsonl`、
`dsh-workspace` 一致的 dsh 安装。没有需要安装的运行时依赖：宿主一半只 import Node 内置
模块，浏览器一半只 require 页面本来就加载好的 React。

## 安装

```sh
git clone https://github.com/LowNGhoul/dsh-delete.git
dsh plugin --profile web add "$PWD/dsh-delete"
```

仓库名是 `dsh-delete`，里面的包名是 `dsh-session-admin`——profile 里列出的是包名。
已经在本地有检出的话，直接装那个目录也一样：

```sh
dsh plugin --profile web add /绝对路径/dsh-session-admin
```

装完重启该 profile。这条命令会把包加进 profile 的 bundle 列表，插件的组合补丁靠它生效。

## 怎么用

**在界面里。** 打开那个会话，点会话标题栏右侧的垃圾桶图标（和其他会话操作并排）。
弹窗会先把要删的东西列清楚：标题、所在项目、占用大小、会删掉几个文件、属于哪些工作区，
然后**按一次就真的删掉**。你正在看的那个会话也可以：在 POSIX 文件系统上，即使 agent 还
持有日志的写句柄，日志的目录项也会被 unlink，删除立刻生效，不需要重启。

**在会话里用命令。**

```
/delete                  # 删你正在看的这个（前提是它不是当前活跃会话）
/delete <session-id>     # 删任意已存储的会话
```

**在终端里，不需要 dsh 进程在跑。**

```sh
npx dsh-session-admin list
npx dsh-session-admin inspect <session-id>
npx dsh-session-admin delete <session-id> --yes
```

## 到底删了什么

一个 dsh 会话不止一个文件。只删日志会在侧边栏留下一个点不开的空行，所以真正的删除要覆盖：

| 内容 | 默认位置 |
| --- | --- |
| 会话日志（所有格式代次） | `$DSH_HOME/sessions/--<项目>--/<id>/session.v<N>.jsonl[.zstd]` |
| 投影缓存（侧边栏标题、统计、待办） | `$DSH_HOME/storages/session_projcache/sessions/<id>.json` |
| 工作区登记 | `$DSH_HOME/storages/workspace.json` → `tables.workspaces[*].sessionIds` |
| 归档标记 | `$DSH_HOME/storages/workspace.json` → `global.archivedSessionIds` |

有两样东西是故意不动的：

**附件。** `$DSH_HOME/attachments/v1` 按内容哈希存放图片和文件，同样的字节被所有用过它的
会话共用，单删一个会话并不拥有它们。弹窗会把该会话引用过的附件数量报给你，字节留在原地。

**唯一不能立刻删的情况：这个会话正被另一个进程使用。** 比如同一个仓库上还跑着第二个 dsh
实例。这种情况用命令行删。延迟删除的机制仍然保留，给把 `allowLiveDeletion` 关掉的部署用：
那时在打开状态下标记的会话会先落盘记录，等它关闭或下次启动时删除，
`dsh-session-admin settle` 可以在没有服务运行时把这些一次做完。

## 配置项

在 `cordis.patch.yml` 里该插件那一行下面：

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `backup` | `false` | 把文件移到 `<home>/session-admin/trash/<时间戳>-<id>/`，而不是直接 unlink。会话照样从 dsh 里消失。 |
| `enableCommand` | `true` | 注册 `/delete` 命令。 |
| `commandName` | `delete` | 换一个命令名。 |
| `enableRpc` | `true` | 提供界面按钮用的浏览器通道。 |
| `allowLiveDeletion` | `true` | 允许确认后的删除直接删掉正在阅读的会话，而不是推迟到它关闭。 |
| `journal` | `true` | 写删除台账和「关闭后删除」的待办记录。 |
| `finishOnClose` | `true` | 会话一关闭就把排队中的删除做完。 |
| `dshHome`、`sessionsRoot`、`storagesRoot` | 自动解析 | 指向非默认的 harness 主目录或存储。 |

## 安全设计

每条删除路径都需要一次明确的动作。界面里要在弹窗中再按一次，而弹窗会先说明会删什么；
命令行不加 `--yes` 就拒绝执行，并打印同样的预览。

删除必须自证成功才会报告成功：磁盘上的日志声明的是别的会话时拒绝删除，只剩投影缓存而
日志已经不在时也拒绝（那说明没有对话可删）。删完之后会逐个路径复查，只要还有残留就报
`SESSION_ADMIN_DELETION_INCOMPLETE`。中途取消会留下待办记录，之后可以查出来并补完：

```sh
dsh-session-admin settle             # 把排队中/中断的删除一次做完
dsh-session-admin recover            # 列出没做完的删除
dsh-session-admin repair             # 把历史删除重新应用到 workspace.json
```

`repair` 的存在是因为运行中的 dsh 把工作区注册表缓存在内存里，下一次无关的写入可能把已删
的 id 又写回文件。插件在启动时和每次删除前都会跑一遍修复，让文件和事实保持一致。

引擎遇到软链接的存储条目会拒绝而不是跟进去（包括软链接的项目目录和软链接的 `sessions`
根目录），路径包含关系按真实路径判断而不是字符串，每个会话 id 在变成路径之前都要过一遍
严格的字符白名单，重写 `workspace.json` 用原子替换并保留原文件权限。每个威胁对应的防护
措施和测试在 `SECURITY.md` 里逐条列出，其中也写明了删除有意不覆盖的两样东西：共享的附件
字节，以及分叉子会话里复制过去的内容。

## 测试

```sh
npm test
```

85 个测试各自在临时目录里搭一套存储。覆盖删除本身，以及各种「不能误报成功」和「不能删错」
的路径：v0 日志、被手工改名的项目目录、只剩元数据、日志身份不符；活跃会话、不存在的 id、
恶意请求体、软链接目录与软链接根、带原型污染键的存储文档；还有工作区修复循环、宿主插件
策略、通信契约、浏览器端组件和命令注册。`real Cordis runtime` 一组会加载 dsh 自带的真实
`@deepseek-ai/cordis`，把插件放进真实 fiber 树里跑；没有 dsh 时自动跳过。测试不会读写真实
的 `$DSH_HOME`。

## 许可

MIT。
