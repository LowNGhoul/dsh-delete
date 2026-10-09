# dsh-session-admin

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）里的会话彻底删掉。

dsh 自带的「归档」只是把会话从侧边栏藏起来，磁盘上的东西一个字节都没少。这个插件做的是
另一件事：删掉会话的追加式日志、投影缓存、工作区登记和归档标记。删完就没了，不能恢复。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-session-admin
```

装完重启该 profile。这条命令会把包加进 profile 的 bundle 列表，插件的组合补丁靠它生效。

## 怎么用

**在界面里。** 打开那个会话，点会话标题栏右侧的垃圾桶图标（和其他会话操作并排）。
弹窗会先把要删的东西列清楚：标题、所在项目、占用大小、会删掉几个文件、属于哪些工作区。
在你按下「彻底删除」之前，什么都不会发生。

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

**你正在用的那个会话。** 活跃会话的 agent 对日志持有写入句柄，把文件从它脚下抽走会丢掉
它接下来要写的内容。这种情况下弹窗会改成「关闭后删除」，等你切到别的会话时自动完成。
命令行工具没这个限制，因为它在自己的进程里跑。

## 配置项

在 `cordis.patch.yml` 里该插件那一行下面：

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `backup` | `false` | 把文件移到 `<home>/session-admin/trash/<时间戳>-<id>/`，而不是直接 unlink。会话照样从 dsh 里消失。 |
| `enableCommand` | `true` | 注册 `/delete` 命令。 |
| `commandName` | `delete` | 换一个命令名。 |
| `enableRpc` | `true` | 提供界面按钮用的浏览器通道。 |
| `journal` | `true` | 写删除台账和「关闭后删除」的待办记录。 |
| `finishOnClose` | `true` | 会话一关闭就把排队中的删除做完。 |
| `dshHome`、`sessionsRoot`、`storagesRoot` | 自动解析 | 指向非默认的 harness 主目录或存储。 |

## 安全设计

每条删除路径都需要一次明确的动作。界面里要在弹窗中再按一次，而弹窗会先说明会删什么；
命令行不加 `--yes` 就拒绝执行，并打印同样的预览。删除开始前先写日志记录，完成后写台账，
所以中断的删除留下痕迹，也可以幂等地补完：

```sh
dsh-session-admin recover
```

引擎遇到软链接的存储条目会拒绝而不是跟进去，每个会话 id 在变成路径之前都要过一遍严格的
字符白名单，重写 `workspace.json` 用的是原子替换并保留原文件权限。每个威胁对应的防护措施
和测试在 `SECURITY.md` 里有逐条说明。

## 测试

```sh
npm test
```

43 个测试各自在临时目录里搭一套存储。覆盖删除本身，以及各种拒绝路径：活跃会话、不存在的
id、恶意请求体、软链接目录、带原型污染键的存储文档，还有宿主插件的策略、通信契约和命令
注册。测试不会读写真实的 `$DSH_HOME`。

## 许可

MIT。
